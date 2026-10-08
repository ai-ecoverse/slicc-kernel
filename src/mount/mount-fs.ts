import { type FsStat, inodeOf, type KernelFs, normalizePath } from '../fs/types.ts';
import { DriverConnection, type DriverPortLike, errnoError } from './connection.ts';
import type { DriverAttr, DriverCapabilities, DriverEntry, DriverStatfs } from './protocol.ts';

export interface MountSpec {
  type: string;
  source: string;
  target: string;
  options?: Record<string, string>;
}

export interface MountEntry {
  type: string;
  source: string;
  target: string;
  options: Record<string, string>;
  state: 'ok' | 'failed' | 'nomedium';
  error?: string;
}

export interface OpenedDriver {
  port: DriverPortLike;
  dispose(): void;
  onCrash?(listener: (error: Error) => void): void;
  present?(): boolean;
}

export interface MountDeps {
  open(type: string, spec: MountSpec): Promise<OpenedDriver>;
  busy(target: string): boolean;
  changed?(...paths: string[]): void;
  timeoutMs?: number;
}

interface Cached<T> {
  value: T;
  expires: number;
}

interface Mount extends MountEntry {
  dev: number;
  conn: DriverConnection;
  caps: DriverCapabilities;
  maxFile: number;
  attrs: Map<string, Cached<DriverAttr>>;
  lists: Map<string, Cached<DriverEntry[]>>;
  dispose(): void;
  present?(): boolean;
}

const MAX_LINKS = 40;
const STALE_RETRIES = 3;
const DEFAULT_IO = 8 * 1024 * 1024;
const UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i.exec(text.trim());
  if (!match) throw errnoError('EINVAL', `not a size: ${text}`);
  return Math.floor(Number(match[1]) * (UNITS[(match[2] as string).toLowerCase()] as number));
}

const within = (path: string, target: string) =>
  path === target || target === '/' || path.startsWith(`${target}/`);
export function heldUnder(held: Iterable<Map<string, number>>, target: string): boolean {
  for (const paths of held) for (const path of paths.keys()) if (within(path, target)) return true;
  return false;
}

export class HeldPaths extends Map<string, number> {
  private readonly revoked = new Set<string>();

  hold(path: string, on: boolean): void {
    const count = (this.get(path) ?? 0) + (on ? 1 : -1);
    if (count > 0) this.set(path, count);
    else {
      this.delete(path);
      this.revoked.delete(path);
    }
  }

  revoke(prefix: string): void {
    for (const path of this.keys()) if (within(path, prefix)) this.revoked.add(path);
  }

  renamed(from: string, to: string): void {
    for (const [path, count] of [...this]) {
      if (!within(path, from)) continue;
      const moved = to + path.slice(from.length);
      this.delete(path);
      this.set(moved, (this.get(moved) ?? 0) + count);
      if (this.revoked.delete(path)) this.revoked.add(moved);
    }
  }

  isRevoked(path: string): boolean {
    return this.revoked.has(path);
  }
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

const readonly = (mount: Mount): boolean =>
  mount.caps.readonly === true || mount.options.ro !== undefined;

function statOf(attr: DriverAttr, path: string, mount: Mount): FsStat {
  const mtime = new Date(attr.mtime);
  const fallback =
    attr.kind === 'directory' ? 0o40755 : attr.kind === 'symlink' ? 0o120777 : 0o100644;
  return {
    isFile: attr.kind === 'file',
    isDirectory: attr.kind === 'directory',
    isSymbolicLink: attr.kind === 'symlink',
    size: attr.size,
    mode: attr.mode ?? fallback,
    mtime,
    atime: mtime,
    ctime: mtime,
    ino: attr.ino ?? inodeOf(path),
    dev: mount.dev,
    ...(readonly(mount) ? { readonly: true } : {}),
    ...(mount.maxFile > 0 ? { maxFile: mount.maxFile } : {}),
  };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.length === total) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export class MountTable {
  private readonly mounts = new Map<string, Mount>();
  private devices = 0;
  private readonly pending = new Set<string>();
  private readonly deps: MountDeps;

  constructor(deps: MountDeps) {
    this.deps = deps;
  }

  mounted(target: string): MountEntry | undefined {
    return this.mounts.get(target);
  }

  list(): MountEntry[] {
    return [...this.mounts.values()].map(
      ({ type, source, target, options, state, error, present }) => ({
        type,
        source,
        target,
        options: { ...options },
        state: state === 'ok' && present?.() === false ? 'nomedium' : state,
        ...(error ? { error } : {}),
      })
    );
  }

  locate(path: string): { mount: Mount; rel: string } | undefined {
    let best: Mount | undefined;
    for (const mount of this.mounts.values()) {
      if (within(path, mount.target) && (!best || mount.target.length > best.target.length))
        best = mount;
    }
    if (!best) return undefined;
    const rel = best.target === '/' ? path : path.slice(best.target.length);
    return { mount: best, rel: rel || '/' };
  }

  async mount(spec: MountSpec, fs: KernelFs): Promise<MountEntry> {
    const target = normalizePath(spec.target);
    if (this.mounts.has(target) || this.pending.has(target)) {
      throw errnoError('EBUSY', `${target} is already mounted`);
    }
    this.pending.add(target);
    try {
      return await this.attach(spec, target, fs);
    } finally {
      this.pending.delete(target);
    }
  }

  private async attach(spec: MountSpec, target: string, fs: KernelFs): Promise<MountEntry> {
    const st = await fs.stat(target);
    if (!st.isDirectory) throw errnoError('ENOTDIR', target);
    const options = { ...spec.options };
    const maxFile = options.maxfile !== undefined ? parseSize(options.maxfile) : undefined;
    const opened = await this.deps.open(spec.type, { ...spec, target, options });
    let mounted: Mount | undefined;
    const started = Promise.withResolvers<never>();
    opened.onCrash?.((error) => {
      if (mounted) this.crashed(mounted, error);
      else
        started.reject(
          errnoError('EIO', `the ${spec.type} driver failed to start: ${error.message}`)
        );
    });
    let conn: DriverConnection;
    try {
      conn = await Promise.race([
        DriverConnection.open(
          opened.port,
          { source: spec.source, options },
          {
            ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
            onInvalidate: (paths) => this.invalidated(target, paths),
            onFail: (error) => {
              if (mounted) this.crashed(mounted, error);
            },
          }
        ),
        started.promise,
      ]);
    } catch (err) {
      opened.dispose();
      throw err;
    }
    const caps = conn.capabilities;
    const mount: Mount = {
      type: spec.type,
      source: spec.source,
      target,
      options,
      state: 'ok',
      dev: 256 + ++this.devices,
      conn,
      caps,
      maxFile: maxFile ?? caps.maxFile ?? 0,
      attrs: new Map(),
      lists: new Map(),
      dispose: () => opened.dispose(),
      ...(opened.present ? { present: opened.present } : {}),
    };
    mounted = mount;
    this.mounts.set(target, mount);
    return this.list().find((m) => m.target === target) as MountEntry;
  }

  umount(target: string, detach = false): void {
    const at = normalizePath(target);
    const mount = this.mounts.get(at);
    if (!mount) throw errnoError('EINVAL', `${at} is not mounted`);
    if (!detach && this.deps.busy(at)) throw errnoError('EBUSY', `${at} has open files`);
    this.mounts.delete(at);
    mount.conn.close();
    mount.dispose();
  }

  private crashed(mount: Mount, error: Error): void {
    mount.state = 'failed';
    mount.attrs.clear();
    mount.lists.clear();
    mount.error = error.message;
    mount.conn.fail(
      errnoError('EIO', `the ${mount.type} driver for ${mount.target} failed: ${error.message}`)
    );
  }

  private invalidated(target: string, paths: string[] | true): void {
    const mount = this.mounts.get(target);
    if (!mount) return;
    if (paths === true) {
      mount.attrs.clear();
      mount.lists.clear();
      this.deps.changed?.(target);
      return;
    }
    const full = paths.map((p) => normalizePath(`${target}/${p}`));
    for (const path of full) this.forget(mount, path);
    this.deps.changed?.(...full);
  }

  forget(mount: Mount, path: string): void {
    for (const key of [...mount.attrs.keys()]) if (within(key, path)) mount.attrs.delete(key);
    mount.lists.delete(path);
    mount.lists.delete(parentOf(path));
    for (const key of [...mount.lists.keys()]) if (within(key, path)) mount.lists.delete(key);
  }

  async getattr(mount: Mount, path: string, rel: string): Promise<DriverAttr> {
    if (mount.conn.failure) throw mount.conn.failure;
    const cached = mount.attrs.get(path);
    if (cached && cached.expires > Date.now()) return cached.value;
    const attr = (await mount.conn.call({ op: 'getattr', path: rel })) as DriverAttr;
    const ttl = mount.caps.attrTtl ?? 1000;
    if (ttl > 0) mount.attrs.set(path, { value: attr, expires: Date.now() + ttl });
    return attr;
  }

  async readdir(mount: Mount, path: string, rel: string): Promise<DriverEntry[]> {
    if (mount.conn.failure) throw mount.conn.failure;
    const cached = mount.lists.get(path);
    if (cached && cached.expires > Date.now()) return cached.value;
    const entries = (await mount.conn.call({ op: 'readdir', path: rel })) as DriverEntry[];
    const ttl = mount.caps.entryTtl ?? mount.caps.attrTtl ?? 1000;
    if (ttl > 0) mount.lists.set(path, { value: entries, expires: Date.now() + ttl });
    return entries;
  }

  async statfs(path: string): Promise<{ quota: number; usage: number } | undefined> {
    const found = this.locate(normalizePath(path));
    if (!found) return undefined;
    const st = (await found.mount.conn.call({ op: 'statfs' })) as DriverStatfs | null;
    if (!st) return { quota: 0, usage: 0 };
    return { quota: st.blocks * st.bsize, usage: (st.blocks - st.bfree) * st.bsize };
  }

  wrap(base: KernelFs): KernelFs {
    return new MountFs(this, base);
  }
}

type Located = { mount: Mount; rel: string };

class MountFs implements KernelFs {
  private readonly table: MountTable;
  private readonly base: KernelFs;

  constructor(table: MountTable, base: KernelFs) {
    this.table = table;
    this.base = base;
  }

  private at(path: string): Located | undefined {
    return this.table.locate(normalizePath(path));
  }

  private writable(mount: Mount, path: string): void {
    if (readonly(mount)) throw errnoError('EROFS', path);
  }

  private async follow(path: string, hops = 0, create = false): Promise<string> {
    const found = this.at(path);
    if (!found) return path;
    const real = normalizePath(path);
    let attr: DriverAttr;
    try {
      attr = await this.table.getattr(found.mount, real, found.rel);
    } catch (err) {
      if (create && (err as { code?: unknown }).code === 'ENOENT') return real;
      throw err;
    }
    if (attr.kind !== 'symlink') return real;
    if (hops >= MAX_LINKS) throw errnoError('ELOOP', path);
    const target = (await found.mount.conn.call({ op: 'readlink', path: found.rel })) as string;
    return this.follow(this.base.resolvePath(parentOf(real), target), hops + 1, create);
  }

  private async open(mount: Mount, rel: string, write: boolean): Promise<number> {
    return (await mount.conn.call({
      op: 'open',
      path: rel,
      write,
      create: write,
      truncate: write,
      exclusive: false,
    })) as number;
  }

  resolvePath(base: string, path: string): string {
    return this.base.resolvePath(base, path);
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const real = await this.follow(path);
    const found = this.at(real);
    if (!found) return this.base.readFileBuffer(real);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.readWhole(found.mount, real, found.rel);
      } catch (err) {
        if ((err as { code?: unknown }).code !== 'ESTALE' || attempt >= STALE_RETRIES) throw err;
        this.table.forget(found.mount, real);
      }
    }
  }

  private async readWhole(mount: Mount, real: string, rel: string): Promise<Uint8Array> {
    const attr = await this.table.getattr(mount, real, rel);
    if (attr.kind === 'directory') throw errnoError('EISDIR', real);
    if (mount.maxFile > 0 && attr.size > mount.maxFile) {
      throw errnoError('EFBIG', `${real} is larger than this mount's maxfile (${mount.maxFile})`);
    }
    const fh = await this.open(mount, rel, false);
    const chunk = mount.caps.maxIo ?? DEFAULT_IO;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const bytes = (await mount.conn.call({
          op: 'read',
          fh,
          offset: total,
          size: chunk,
        })) as Uint8Array;
        if (bytes.length === 0) break;
        chunks.push(bytes);
        total += bytes.length;
        if (bytes.length < chunk && total >= attr.size) break;
      }
    } finally {
      await mount.conn.call({ op: 'release', fh });
    }
    return concat(chunks, total);
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    const real = await this.follow(path, 0, true);
    const found = this.at(real);
    if (!found) return this.base.writeFile(real, content);
    const { mount, rel } = found;
    this.writable(mount, real);
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    if (mount.maxFile > 0 && bytes.length > mount.maxFile) {
      throw errnoError(
        'EFBIG',
        `${real} would be larger than this mount's maxfile (${mount.maxFile})`
      );
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.writeWhole(mount, real, rel, bytes);
      } catch (err) {
        if ((err as { code?: unknown }).code !== 'ESTALE' || attempt >= STALE_RETRIES) throw err;
      }
    }
  }

  private async writeWhole(mount: Mount, real: string, rel: string, bytes: Uint8Array) {
    this.table.forget(mount, real);
    const fh = await this.open(mount, rel, true);
    const chunk = mount.caps.maxIo ?? DEFAULT_IO;
    try {
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        await mount.conn.call({
          op: 'write',
          fh,
          offset,
          bytes: bytes.slice(offset, offset + chunk),
        });
      }
    } finally {
      await mount.conn.call({ op: 'release', fh });
      this.table.forget(mount, real);
    }
  }

  async exists(path: string): Promise<boolean> {
    if (!this.at(path)) return this.base.exists(path);
    try {
      await this.stat(path);
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw err;
    }
  }

  async lstat(path: string): Promise<FsStat> {
    const found = this.at(path);
    if (!found) return this.base.lstat(path);
    const real = normalizePath(path);
    return statOf(await this.table.getattr(found.mount, real, found.rel), real, found.mount);
  }

  async stat(path: string): Promise<FsStat> {
    const real = await this.follow(path);
    return this.at(real) ? this.lstat(real) : this.base.stat(real);
  }

  private async entries(
    path: string
  ): Promise<{ real: string; mount: Mount; list: DriverEntry[] }> {
    const real = await this.follow(path);
    const found = this.at(real);
    if (!found) throw errnoError('ENOTDIR', real);
    return {
      real,
      mount: found.mount,
      list: await this.table.readdir(found.mount, real, found.rel),
    };
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.at(path)) return this.base.readdir(path);
    return (await this.entries(path)).list.map((e) => e.name);
  }

  async readdirStat(path: string): Promise<Array<[string, FsStat | null]>> {
    if (!this.at(path)) return this.base.readdirStat(path);
    const { real, mount, list } = await this.entries(path);
    return Promise.all(
      list.map(async (entry): Promise<[string, FsStat | null]> => {
        const child = normalizePath(`${real}/${entry.name}`);
        if (entry.attr && mount.caps.listingStats) {
          return [entry.name, statOf(entry.attr, child, mount)];
        }
        return [entry.name, await this.lstat(child).catch(() => null)];
      })
    );
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const found = this.at(path);
    if (!found) return this.base.mkdir(path, options);
    const { mount, rel } = found;
    const real = normalizePath(path);
    this.writable(mount, real);
    if (!options.recursive) {
      if (rel === '/') throw errnoError('EEXIST', real);
      this.table.forget(mount, real);
      await mount.conn.call({ op: 'mkdir', path: rel });
      return;
    }
    const parts = rel.split('/').filter(Boolean);
    for (let n = 1; n <= parts.length; n++) {
      const sub = `/${parts.slice(0, n).join('/')}`;
      const full = normalizePath(`${mount.target}${sub}`);
      const exists = await this.table.getattr(mount, full, sub).catch(() => undefined);
      if (exists?.kind === 'directory') continue;
      if (exists) throw errnoError('ENOTDIR', full);
      this.table.forget(mount, full);
      await mount.conn.call({ op: 'mkdir', path: sub });
    }
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    const found = this.at(path);
    if (!found) return this.base.rm(path, options);
    const { mount, rel } = found;
    const real = normalizePath(path);
    if (rel === '/') throw errnoError('EBUSY', `${real} is a mount point`);
    this.writable(mount, real);
    let attr: DriverAttr;
    try {
      attr = await this.table.getattr(mount, real, rel);
    } catch (err) {
      if (options.force && (err as { code?: unknown }).code === 'ENOENT') return;
      throw err;
    }
    this.table.forget(mount, real);
    if (attr.kind === 'directory' && options.recursive) {
      for (const entry of await this.table.readdir(mount, real, rel)) {
        await this.rm(`${real}/${entry.name}`, { recursive: true, force: options.force ?? false });
      }
      this.table.forget(mount, real);
    }
    await mount.conn.call({ op: attr.kind === 'directory' ? 'rmdir' : 'unlink', path: rel });
    this.table.forget(mount, real);
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.at(from);
    const b = this.at(to);
    if (!a && !b) return this.base.rename(from, to);
    if (!a || !b || a.mount !== b.mount) throw errnoError('EXDEV', `${from} -> ${to}`);
    this.writable(a.mount, normalizePath(to));
    this.table.forget(a.mount, normalizePath(from));
    this.table.forget(a.mount, normalizePath(to));
    try {
      await a.mount.conn.call({ op: 'rename', from: a.rel, to: b.rel });
    } finally {
      this.table.forget(a.mount, normalizePath(from));
      this.table.forget(a.mount, normalizePath(to));
    }
  }

  async symlink(target: string, path: string): Promise<void> {
    const found = this.at(path);
    if (!found) return this.base.symlink(target, path);
    this.writable(found.mount, normalizePath(path));
    if (!found.mount.caps.symlinks)
      throw errnoError('EPERM', `${path}: this file system has no symlinks`);
    this.table.forget(found.mount, normalizePath(path));
    await found.mount.conn.call({ op: 'symlink', target, path: found.rel });
  }

  async readlink(path: string): Promise<string> {
    const found = this.at(path);
    if (!found) return this.base.readlink(path);
    return (await found.mount.conn.call({ op: 'readlink', path: found.rel })) as string;
  }

  async chmod(path: string, mode: number): Promise<void> {
    const found = this.at(path);
    if (!found) return this.base.chmod(path, mode);
    this.writable(found.mount, normalizePath(path));
    if (!found.mount.caps.chmod) return;
    this.table.forget(found.mount, normalizePath(path));
    await found.mount.conn.call({ op: 'setattr', path: found.rel, mode });
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const found = this.at(path);
    if (!found) return this.base.utimes(path, atime, mtime);
    this.writable(found.mount, normalizePath(path));
    this.table.forget(found.mount, normalizePath(path));
    await found.mount.conn.call({ op: 'setattr', path: found.rel, mtime: mtime.getTime() });
  }
}
