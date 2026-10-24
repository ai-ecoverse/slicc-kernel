import { fresh } from '../bytes.ts';
import { ancestryOf, permOf } from '../fs/access.ts';
import { copyByBytes } from '../fs/copy.ts';
import { chain } from '../fs/owners.ts';
import {
  type CopyOptions,
  type FsStat,
  inodeOf,
  type KernelFs,
  lutimesOf,
  mayLink,
  type NewOwner,
  normalizePath,
  type OwnerChange,
  type Perm,
  type PwriteOptions,
  redirectOf,
} from '../fs/types.ts';
import type { KeptFile, UnlinkHolder } from '../fs/unlinked.ts';
import { view } from '../fs/view.ts';
import { joinName, realDir, realTarget } from '../fs/walk.ts';
import { DriverConnection, type DriverPortLike, errnoError } from './connection.ts';
import type {
  DriverAttr,
  DriverCapabilities,
  DriverEntry,
  DriverOwner,
  DriverStatfs,
} from './protocol.ts';

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
  state: 'ok' | 'failed' | 'nomedium' | 'pending';
  error?: string;
}

export interface OpenedDriver {
  port: DriverPortLike;
  dispose(): void;
  onCrash?(listener: (error: Error) => void): void;
  present?(): boolean;
  idle?: true;
}

export interface MountDeps {
  open(type: string, spec: MountSpec): Promise<OpenedDriver>;
  busy(target: string): boolean;
  changed?(...paths: string[]): void;
  doubted?(target: string): void;
  reshaped?(): void;
  timeoutMs?: number;
  owners?: boolean;
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
  epoch: number;
  owners: boolean;
  dispose(): void;
  present?(): boolean;
}

const S_ISGID = 0o2000;
const ID = /^\d{1,10}$/;
const MAX_ID = 0xfffffffe;

function idOption(value: string | undefined): number {
  return value === undefined ? 0 : Number(value);
}

function checkIds(options: Record<string, string>): void {
  for (const key of ['uid', 'gid']) {
    const value = options[key];
    if (value === undefined) continue;
    if (!ID.test(value) || Number(value) > MAX_ID) throw errnoError('EINVAL', `${key}=${value}`);
  }
}

const MAX_LINKS = 40;
const STALE_RETRIES = 3;
const SETTLE_ROUNDS = 4;
const DEFAULT_IO = 8 * 1024 * 1024;
const UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i.exec(text.trim());
  if (!match) throw errnoError('EINVAL', `not a size: ${text}`);
  return Math.floor(Number(match[1]) * (UNITS[(match[2] as string).toLowerCase()] as number));
}

function linkedTo(mount: Mount, path: string): (attr: DriverAttr | undefined) => boolean {
  const own = mount.attrs.get(path)?.value;
  const ino = own?.kind === 'directory' ? undefined : own?.ino;
  return (attr) => {
    if (!attr || attr.kind === 'directory') return false;
    if (ino !== undefined) return attr.ino === ino;
    return own?.kind !== 'directory' && (attr.nlink ?? 1) > 1;
  };
}

const within = (path: string, target: string) =>
  path === target || target === '/' || path.startsWith(`${target}/`);
export class HeldSet extends Set<HeldPaths> {
  private readonly idle: (path: string) => void;

  constructor(idle: (path: string) => void) {
    super();
    this.idle = idle;
  }

  override add(holds: HeldPaths): this {
    holds.onIdle = this.idle;
    return super.add(holds);
  }

  doubt(paths: readonly string[], over?: string): void {
    for (const holds of this) {
      for (const path of paths) holds.doubt(path, true);
      if (over !== undefined) holds.doubt(over);
    }
  }

  async bindIds(id: (path: string) => Promise<string> | undefined): Promise<void> {
    for (const holds of [...this]) await holds.bindIds(id);
  }

  override delete(holds: HeldPaths): boolean {
    const removed = super.delete(holds);
    for (const path of new Set([...holds.keys(), ...holds.opens.keys()])) this.idle(path);
    holds.releaseAll();
    return removed;
  }
}

export function heldUnder(held: Iterable<Map<string, number>>, target: string): boolean {
  for (const paths of held) for (const path of paths.keys()) if (within(path, target)) return true;
  return false;
}

export class HeldPaths extends Map<string, number> implements UnlinkHolder {
  private readonly revoked = new Set<string>();
  readonly opens = new Map<string, number>();
  readonly unlinked = new Map<string, KeptFile>();
  private readonly aliases = new Map<string, string>();
  private readonly handles = new Map<number, string>();
  private readonly keptHandles = new Map<number, KeptFile>();
  private readonly uses = new Map<KeptFile, number>();
  private lastHandle = 0;
  private owning: string | undefined;
  private readonly bound = new Map<number, { ino: number; fid?: string }>();
  private readonly doubted = new Map<number, number>();
  private doubts = 0;

  onIdle?: (path: string) => void;

  keyOf(path: string): string {
    return this.aliases.get(path) ?? path;
  }

  keptAt(path: string): KeptFile | undefined {
    return this.unlinked.get(this.keyOf(path));
  }

  holding(path: string): boolean {
    return this.opens.has(this.keyOf(path));
  }

  held(): Iterable<string> {
    return this.opens.keys();
  }

  isKept(path: string): boolean {
    const ids = this.handlesAt(path);
    return ids.length === 0 ? this.unlinked.has(path) : ids.every((id) => this.keptHandles.has(id));
  }

  private handlesAt(path: string): number[] {
    return [...this.handles].filter(([, key]) => key === path).map(([id]) => id);
  }

  doubt(over: string, exact = false): void {
    if (this.bound.size === 0) return;
    for (const [handle, key] of this.handles) {
      if (!this.bound.has(handle) || this.keptHandles.has(handle)) continue;
      if (exact ? key === over : within(key, over)) this.doubted.set(handle, ++this.doubts);
    }
  }

  boundIno(handle: number): { ino: number; fid?: string; doubt: number } | undefined {
    const doubt = this.doubted.get(handle);
    const bound = this.bound.get(handle);
    return doubt === undefined || bound === undefined ? undefined : { ...bound, doubt };
  }

  async bindIds(id: (path: string) => Promise<string> | undefined): Promise<void> {
    for (const [handle, bound] of [...this.bound]) {
      const key = this.handles.get(handle);
      if (bound.fid !== undefined || key === undefined) continue;
      const fid = await id(key)?.catch(() => undefined);
      if (fid !== undefined && this.bound.get(handle) === bound)
        this.bound.set(handle, { ...bound, fid });
    }
  }

  trust(handle: number, doubt: number): void {
    if (this.doubted.get(handle) === doubt) this.doubted.delete(handle);
  }

  pathOf(handle: number): string | undefined {
    return this.handles.get(handle);
  }

  keptFor(handle: number): KeptFile | undefined {
    return this.keptHandles.get(handle);
  }

  holdsHandle(handle: number): boolean {
    return this.handles.has(handle);
  }

  keeps(hidden: string): boolean {
    for (const file of this.uses.keys()) if (file.hidden === hidden) return true;
    for (const file of this.unlinked.values()) if (file.hidden === hidden) return true;
    return false;
  }

  keep(path: string, file: KeptFile): void {
    const fresh = this.handlesAt(path).filter((id) => !this.keptHandles.has(id));
    for (const id of fresh) this.keptHandles.set(id, file);
    this.uses.set(file, Math.max(fresh.length, 1));
    this.unlinked.set(path, file);
  }

  unkeep(path: string, file: KeptFile): void {
    for (const [id, kept] of this.keptHandles) if (kept === file) this.keptHandles.delete(id);
    this.uses.delete(file);
    if (this.unlinked.get(path) === file) this.unlinked.delete(path);
  }

  private letGo(file: KeptFile, all = false): void {
    const left = all ? 0 : (this.uses.get(file) ?? 0) - 1;
    if (left > 0) {
      this.uses.set(file, left);
      return;
    }
    if (!this.uses.delete(file)) return;
    file.release();
    for (const [path, kept] of this.unlinked) if (kept === file) this.unlinked.delete(path);
  }

  releaseAll(): void {
    for (const file of [...this.uses.keys()]) this.letGo(file, true);
    this.keptHandles.clear();
  }

  hold(
    path: string,
    on: boolean,
    open = false,
    real?: string,
    handle?: number,
    ino?: number,
    fid?: string
  ): number | undefined {
    if (open) {
      const made = this.holdOpen(path, on, real, handle);
      if (handle !== undefined) {
        this.bound.delete(handle);
        this.doubted.delete(handle);
      }
      if (made !== undefined && ino !== undefined)
        this.bound.set(made, fid === undefined ? { ino } : { ino, fid });
      return made;
    }
    this.holdWrite(path, on);
    return undefined;
  }

  private holdOpen(path: string, on: boolean, real?: string, handle?: number): number | undefined {
    const known = handle === undefined ? undefined : this.handles.get(handle);
    const key = known ?? real ?? this.keyOf(path);
    if (key !== path) this.aliases.set(path, key);
    if (handle !== undefined) {
      const kept = this.keptHandles.get(handle);
      this.handles.delete(handle);
      this.keptHandles.delete(handle);
      if (kept) this.letGo(kept);
    }
    const count = (this.opens.get(key) ?? 0) + (on ? 1 : -1);
    if (count > 0) this.opens.set(key, count);
    else {
      this.opens.delete(key);
      for (const id of this.handlesAt(key)) this.handles.delete(id);
      const kept = this.unlinked.get(key);
      if (kept) this.letGo(kept, true);
      for (const [alias, target] of this.aliases) if (target === key) this.aliases.delete(alias);
      this.onIdle?.(key);
    }
    if (!on) return undefined;
    this.handles.set(++this.lastHandle, key);
    return this.lastHandle;
  }

  private holdWrite(path: string, on: boolean): void {
    const count = (this.get(path) ?? 0) + (on ? 1 : -1);
    if (count > 0) this.set(path, count);
    else {
      this.delete(path);
      this.revoked.delete(path);
      this.onIdle?.(path);
    }
  }

  async own<T>(path: string, op: () => Promise<T>): Promise<T> {
    this.owning = path;
    try {
      return await op();
    } finally {
      this.owning = undefined;
    }
  }

  owns(path: string): boolean {
    return this.owning === path;
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
    for (const [path, count] of [...this.opens]) {
      if (!within(path, from)) continue;
      const moved = to + path.slice(from.length);
      this.opens.delete(path);
      this.opens.set(moved, (this.opens.get(moved) ?? 0) + count);
    }
    for (const [id, key] of this.handles) {
      if (within(key, from)) this.handles.set(id, to + key.slice(from.length));
    }
  }

  isRevoked(path: string): boolean {
    return this.revoked.has(path);
  }
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

const readonly = (mount: Mount): boolean =>
  mount.caps.readonly === true || mount.options.ro !== undefined;

function inodeless(mount: Mount, attr: DriverAttr): boolean {
  if (attr.ino !== undefined) return false;
  if (mount.caps.links) mount.caps = { ...mount.caps, links: false };
  return true;
}

function statOf(attr: DriverAttr, path: string, mount: Mount): FsStat {
  const mtime = new Date(attr.mtime);
  const fallback =
    attr.kind === 'directory'
      ? 0o40755
      : attr.kind === 'symlink'
        ? 0o120777
        : attr.kind === 'fifo'
          ? 0o10644
          : 0o100644;
  return {
    isFile: attr.kind === 'file',
    isDirectory: attr.kind === 'directory',
    isSymbolicLink: attr.kind === 'symlink',
    ...(attr.kind === 'fifo' ? { isFifo: true } : {}),
    size: attr.size,
    mode: attr.mode ?? fallback,
    mtime,
    atime: attr.atime === undefined ? mtime : new Date(attr.atime),
    ctime: mtime,
    ino: attr.ino ?? inodeOf(path),
    ...(!inodeless(mount, attr) && attr.nlink !== undefined ? { nlink: attr.nlink } : {}),
    dev: mount.dev,
    ...(readonly(mount) ? { readonly: true } : {}),
    ...(mount.maxFile > 0 ? { maxFile: mount.maxFile } : {}),
    ...(mount.caps.ranges ? { ranged: true } : {}),
    ...(mount.caps.links ? { linkable: true } : {}),
    ...(attr.etag !== undefined ? { version: attr.etag } : {}),
    ...(mount.owners
      ? {
          uid: (mount.caps.owners ? attr.uid : undefined) ?? idOption(mount.options.uid),
          gid: (mount.caps.owners ? attr.gid : undefined) ?? idOption(mount.options.gid),
        }
      : {}),
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

function resized(bytes: Uint8Array, size: number): Uint8Array {
  if (size <= bytes.length) return bytes.subarray(0, size);
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

function handed(bytes: Uint8Array, transfer: boolean, chunk: number): boolean {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return transfer && whole && bytes.length <= chunk && bytes.buffer instanceof ArrayBuffer;
}

function spliced(bytes: Uint8Array, offset: number, part: Uint8Array): Uint8Array {
  const out = resized(bytes, Math.max(bytes.length, offset + part.length));
  out.set(part, offset);
  return out;
}

interface WriteSession {
  mount: Mount;
  fh: Promise<number>;
  extents: Array<[number, number]>;
  truncated: boolean;
}

export class MountTable {
  private readonly mounts = new Map<string, Mount>();
  private readonly sessions = new Map<string, WriteSession>();
  private readonly committing = new Map<string, { mount: Mount; done: Promise<void> }>();
  private devices = 0;
  private readonly pending = new Set<string>();
  private readonly notes = new Map<string, MountEntry>();
  private readonly system = new Set<string>();
  private readonly deps: MountDeps;

  constructor(deps: MountDeps) {
    this.deps = deps;
  }

  mounted(target: string): MountEntry | undefined {
    return this.mounts.get(target);
  }

  list(): MountEntry[] {
    const mounted = [...this.mounts.values()].map(
      ({ type, source, target, options, state, error, present }): MountEntry => ({
        type,
        source,
        target,
        options: { ...options },
        state: state === 'ok' && present?.() === false ? 'nomedium' : state,
        ...(error ? { error } : {}),
      })
    );
    const noted = [...this.notes.values()].filter((note) => !this.mounts.has(note.target));
    return [...mounted, ...noted.map((note) => ({ ...note, options: { ...note.options } }))];
  }

  listed(): MountEntry[] {
    return this.list().filter((entry) => !this.system.has(entry.target));
  }

  async mountSystem(spec: MountSpec, fs: KernelFs): Promise<void> {
    await this.mount(spec, fs);
    this.system.add(normalizePath(spec.target));
  }

  note(spec: MountSpec, state: 'pending' | 'failed', error?: string): void {
    const target = normalizePath(spec.target);
    this.notes.set(target, {
      type: spec.type,
      source: spec.source,
      target,
      options: { ...spec.options },
      state,
      ...(error ? { error } : {}),
    });
  }

  under(path: string): boolean {
    for (const mount of this.mounts.values()) if (within(mount.target, path)) return true;
    return false;
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
    if (this.deps.owners) checkIds(options);
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
            ...(opened.idle ? { idle: true } : {}),
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
      epoch: 0,
      owners: this.deps.owners === true,
      dispose: () => opened.dispose(),
      ...(opened.present ? { present: opened.present } : {}),
    };
    mounted = mount;
    this.mounts.set(target, mount);
    this.deps.reshaped?.();
    this.notes.delete(target);
    return this.list().find((m) => m.target === target) as MountEntry;
  }

  unnote(target: string): void {
    this.notes.delete(normalizePath(target));
  }

  umount(target: string, detach = false): void {
    const at = normalizePath(target);
    const mount = this.mounts.get(at);
    if (!mount && this.notes.delete(at)) return;
    if (!mount) throw errnoError('EINVAL', `${at} is not mounted`);
    if (!detach && this.deps.busy(at)) throw errnoError('EBUSY', `${at} has open files`);
    this.system.delete(at);
    this.notes.delete(at);
    this.mounts.delete(at);
    this.deps.reshaped?.();
    const waits = [...this.sessions]
      .filter(([, s]) => s.mount === mount)
      .map(([real]) => this.commit(real));
    for (const c of this.committing.values()) if (c.mount === mount) waits.push(c.done);
    const close = () => {
      mount.conn.close();
      mount.dispose();
    };
    if (waits.length === 0) close();
    else void Promise.allSettled(waits).then(close);
  }

  session(mount: Mount, real: string, rel: string): WriteSession {
    let session = this.sessions.get(real);
    if (!session) {
      const open = () =>
        mount.conn.call({
          op: 'open',
          path: rel,
          write: true,
          create: true,
          truncate: false,
          exclusive: false,
        }) as Promise<number>;
      const before = this.committing.get(real)?.done ?? Promise.resolve();
      const fh = before.then(open, open);
      session = { mount, fh, extents: [], truncated: false };
      this.sessions.set(real, session);
      fh.catch(() => this.sessions.delete(real));
    }
    return session;
  }

  writing(real: string): WriteSession | undefined {
    return this.sessions.get(real);
  }

  async commit(real: string): Promise<void> {
    const session = this.sessions.get(real);
    if (!session) return this.committing.get(real)?.done;
    this.sessions.delete(real);
    session.mount.epoch++;
    const done = (async () => {
      try {
        await session.mount.conn.call({ op: 'release', fh: await session.fh });
      } finally {
        this.forget(session.mount, real);
      }
    })();
    const entry = { mount: session.mount, done };
    this.committing.set(real, entry);
    const settle = () => {
      if (this.committing.get(real) === entry) this.committing.delete(real);
    };
    done.then(settle, settle);
    return done;
  }

  async commitUnder(prefix: string): Promise<void> {
    const at = normalizePath(prefix);
    await Promise.all(
      [...this.sessions.keys()].filter((p) => within(p, at)).map((p) => this.commit(p))
    );
  }

  async commitOverlapping(real: string, offset: number, length: number): Promise<void> {
    const session = this.sessions.get(real);
    if (!session) return;
    const end = offset + length;
    if (session.truncated || session.extents.some(([a, b]) => a < end && offset < b)) {
      await this.commit(real);
    }
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
      this.deps.doubted?.(target);
      this.deps.changed?.(target);
      return;
    }
    const full = paths.map((p) => normalizePath(`${target}/${p}`));
    for (const path of full) this.forget(mount, path);
    this.deps.changed?.(...full);
  }

  forget(mount: Mount, path: string): void {
    mount.epoch++;
    const linked = mount.caps.links ? linkedTo(mount, path) : () => false;
    for (const [key, cached] of [...mount.attrs])
      if (within(key, path) || linked(cached.value)) mount.attrs.delete(key);
    mount.lists.delete(path);
    mount.lists.delete(parentOf(path));
    for (const [key, cached] of [...mount.lists])
      if (within(key, path) || cached.value.some((e) => linked(e.attr))) mount.lists.delete(key);
  }

  async getattr(mount: Mount, path: string, rel: string, settled = false): Promise<DriverAttr> {
    for (let round = 1; ; round++) {
      if (mount.conn.failure) throw mount.conn.failure;
      if (settled) await this.committing.get(path)?.done.catch(() => undefined);
      const cached = mount.attrs.get(path);
      if (cached && cached.expires > Date.now()) return cached.value;
      const seen = mount.epoch;
      const session = this.sessions.get(path);
      const attr = (await mount.conn.call({ op: 'getattr', path: rel })) as DriverAttr;
      if (mount.epoch !== seen) {
        const moved = this.sessions.get(path) !== session || this.committing.has(path);
        if (settled && moved && round < SETTLE_ROUNDS) continue;
        return attr;
      }
      const ttl = mount.caps.attrTtl ?? 1000;
      if (ttl > 0) mount.attrs.set(path, { value: attr, expires: Date.now() + ttl });
      return attr;
    }
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
    base.crossings?.((path) => this.locate(normalizePath(path)) !== undefined);
    return new MountFs(this, base);
  }
}

type Located = { mount: Mount; rel: string };

function noteExtent(extents: Array<[number, number]>, from: number, to: number): void {
  const last = extents.at(-1);
  if (last && from <= last[1] && to >= last[0]) {
    last[0] = Math.min(last[0], from);
    last[1] = Math.max(last[1], to);
  } else extents.push([from, to]);
}

type Relinkable = (...args: unknown[]) => Promise<unknown>;

const RELINKED: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['readFileBuffer', [0]],
  ['writeFile', [0]],
  ['pread', [0]],
  ['pwrite', [0]],
  ['append', [0]],
  ['truncate', [0]],
  ['lstat', [0]],
  ['stat', [0]],
  ['readdir', [0]],
  ['readdirStat', [0]],
  ['mkdir', [0]],
  ['rm', [0]],
  ['rename', [0, 1]],
  ['symlink', [1]],
  ['readlink', [0]],
  ['chown', [0]],
  ['chmod', [0]],
  ['utimes', [0]],
  ['lutimes', [0]],
];

class MountFs implements KernelFs {
  private readonly table: MountTable;
  private readonly base: KernelFs;
  private readonly rejectLinks: boolean;

  constructor(table: MountTable, base: KernelFs, rejectLinks = false) {
    this.table = table;
    this.base = base;
    this.rejectLinks = rejectLinks;
  }

  static {
    const proto = MountFs.prototype as unknown as Record<string, Relinkable>;
    for (const [name, at] of RELINKED) {
      const run = proto[name] as Relinkable;
      proto[name] = async function (this: MountFs, ...args: unknown[]) {
        try {
          return await run.apply(this, args);
        } catch (err) {
          const moved = await this.relinked(err, args, at);
          if (!moved) throw err;
          return ((this as unknown as Record<string, Relinkable>)[name] as Relinkable)(...moved);
        }
      };
    }
  }

  private async relinked(
    err: unknown,
    args: unknown[],
    at: readonly number[]
  ): Promise<unknown[] | undefined> {
    if ((err as { code?: unknown } | null)?.code !== 'ENOTDIR') return undefined;
    const moved = [...args];
    let changed = false;
    for (const i of at) {
      const path = args[i];
      if (typeof path !== 'string' || !this.at(path)) continue;
      const named = await this.named(path).catch(() => undefined);
      if (named === undefined || named === normalizePath(path)) continue;
      if (this.rejectLinks) throw errnoError('ELOOP', path);
      moved[i] = named;
      changed = true;
    }
    return changed ? moved : undefined;
  }

  private at(path: string): Located | undefined {
    return this.table.locate(normalizePath(path));
  }

  private writable(mount: Mount, path: string): void {
    if (readonly(mount)) throw errnoError('EROFS', path);
  }

  private async through(path: string): Promise<string> {
    const real = normalizePath(path);
    if (this.at(real)) return real;
    try {
      await this.base.stat(parentOf(real));
      return real;
    } catch (err) {
      const moved = redirectOf(err);
      return moved ? normalizePath(moved.to + real.slice(moved.of.length)) : real;
    }
  }

  private async across(from: string, to: string, redirects: number): Promise<[string, string]> {
    const moved: [string, string] = [await this.through(from), await this.through(to)];
    const same = moved[0] === normalizePath(from) && moved[1] === normalizePath(to);
    if (same || redirects >= MAX_LINKS) throw errnoError('EXDEV', `${from} -> ${to}`);
    return moved;
  }

  private async based<T>(
    paths: string[],
    redirects: number,
    run: () => Promise<T>,
    again: (moved: string[], redirects: number) => Promise<T>
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const moved = redirectOf(err);
      if (!moved) throw err;
      if (redirects >= MAX_LINKS) throw errnoError('ELOOP', paths[0] as string);
      const at = paths.map((path) => {
        const real = normalizePath(path);
        return within(real, moved.of)
          ? normalizePath(moved.to + real.slice(moved.of.length))
          : real;
      });
      return again(at, redirects + 1);
    }
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
    if (this.rejectLinks) throw errnoError('ELOOP', path);
    if (hops >= MAX_LINKS) throw errnoError('ELOOP', path);
    const target = (await found.mount.conn.call({ op: 'readlink', path: found.rel })) as string;
    return this.follow(this.base.resolvePath(parentOf(real), target), hops + 1, create);
  }

  private async open(
    mount: Mount,
    rel: string,
    write: boolean,
    owner?: DriverOwner,
    create = write
  ): Promise<number> {
    return (await mount.conn.call({
      op: 'open',
      path: rel,
      write,
      create,
      truncate: write,
      exclusive: false,
      ...owner,
    })) as number;
  }

  private async driverOwner(
    found: Located,
    real: string,
    owner: NewOwner | undefined,
    directory: boolean
  ): Promise<DriverOwner | undefined> {
    const { mount, rel } = found;
    if (!owner || !mount.owners || !mount.caps.owners) return undefined;
    const dir = parentOf(real);
    const above = statOf(await this.table.getattr(mount, dir, parentOf(rel)), dir, mount);
    const setgid = (above.mode & S_ISGID) !== 0;
    let mode = owner.mode;
    if (directory && setgid) mode = (mode ?? 0o755) | S_ISGID;
    return {
      uid: owner.uid,
      gid: setgid ? (above.gid as number) : owner.gid,
      ...(mode !== undefined ? { mode } : {}),
    };
  }

  resolvePath(base: string, path: string): string {
    return this.base.resolvePath(base, path);
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  async readFileBuffer(path: string, redirects = 0): Promise<Uint8Array> {
    const real = await this.follow(path);
    const found = this.at(real);
    if (!found) {
      return this.based(
        [real],
        redirects,
        () => this.base.readFileBuffer(real),
        ([to], n) => this.readFileBuffer(to as string, n)
      );
    }
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
    await this.table.commit(real);
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

  async writeFile(
    path: string,
    content: Uint8Array | string,
    owner?: NewOwner,
    redirects = 0
  ): Promise<void> {
    const real = await this.follow(path, 0, true);
    const found = this.at(real);
    if (!found) {
      const write = () => this.base.writeFile(real, content, owner);
      return this.based([real], redirects, write, ([to], n) =>
        this.writeFile(to as string, content, owner, n)
      );
    }
    const { mount, rel } = found;
    this.writable(mount, real);
    if (owner?.fifo) return this.mkfifo(found, real, owner);
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    if (mount.maxFile > 0 && bytes.length > mount.maxFile) {
      throw errnoError(
        'EFBIG',
        `${real} would be larger than this mount's maxfile (${mount.maxFile})`
      );
    }
    const made = owner?.existing ? undefined : await this.driverOwner(found, real, owner, false);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.writeWhole(mount, real, rel, bytes, made, owner?.existing !== true);
      } catch (err) {
        if ((err as { code?: unknown }).code !== 'ESTALE' || attempt >= STALE_RETRIES) throw err;
      }
    }
  }

  private async mkfifo(found: Located, real: string, owner: NewOwner): Promise<void> {
    const { mount, rel } = found;
    if (!mount.caps.fifos) throw errnoError('EPERM', `${real}: this mount has no FIFOs`);
    const made = await this.driverOwner(found, real, owner, false);
    await this.table.commit(real);
    this.table.forget(mount, real);
    try {
      await mount.conn.call({ op: 'mkfifo', path: rel, ...made });
    } finally {
      this.table.forget(mount, real);
    }
  }

  private async writeWhole(
    mount: Mount,
    real: string,
    rel: string,
    bytes: Uint8Array,
    owner?: DriverOwner,
    create = true
  ) {
    await this.table.commit(real);
    this.table.forget(mount, real);
    const fh = await this.open(mount, rel, true, owner, create);
    const chunk = mount.caps.maxIo ?? DEFAULT_IO;
    try {
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        const part = fresh(bytes, offset, offset + chunk);
        await mount.conn.call({ op: 'write', fh, offset, bytes: part }, [part.buffer]);
      }
    } finally {
      await mount.conn.call({ op: 'release', fh });
      this.table.forget(mount, real);
    }
  }

  async pread(
    path: string,
    offset: number,
    length: number,
    version?: string,
    redirects = 0
  ): Promise<Uint8Array> {
    const gone =
      (at: string) =>
      (err: unknown): never => {
        const stale = version !== undefined && (err as { code?: unknown }).code === 'ENOENT';
        throw stale ? errnoError('ESTALE', `${at} is gone from the host`) : err;
      };
    const real = await this.follow(path).catch(gone(path));
    const found = this.at(real);
    const { pread } = this.base;
    if (!found && pread) {
      return this.based(
        [real],
        redirects,
        () => pread.call(this.base, real, offset, length),
        ([to], n) => this.pread(to as string, offset, length, version, n)
      );
    }
    if (!found) return (await this.base.readFileBuffer(real)).slice(offset, offset + length);
    const { mount, rel } = found;
    if ((await this.table.getattr(mount, real, rel).catch(gone(real))).kind === 'directory') {
      throw errnoError('EISDIR', real);
    }
    await this.table.commitOverlapping(real, offset, length);
    const fh = (await mount.conn
      .call({
        op: 'open',
        path: rel,
        write: false,
        create: false,
        truncate: false,
        exclusive: false,
        ...(version !== undefined ? { ifMatch: version } : {}),
      })
      .catch(gone(real))) as number;
    const chunk = mount.caps.maxIo ?? DEFAULT_IO;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < length) {
        const bytes = (await mount.conn.call({
          op: 'read',
          fh,
          offset: offset + total,
          size: Math.min(chunk, length - total),
        })) as Uint8Array;
        if (bytes.length === 0) break;
        chunks.push(bytes);
        total += bytes.length;
      }
    } finally {
      await mount.conn.call({ op: 'release', fh });
    }
    return concat(chunks, total);
  }

  private fits(mount: Mount, real: string, end: number): void {
    if (mount.maxFile > 0 && end > mount.maxFile) {
      throw errnoError(
        'EFBIG',
        `${real} would be larger than this mount's maxfile (${mount.maxFile})`
      );
    }
  }

  async append(
    path: string,
    bytes: Uint8Array,
    options?: PwriteOptions,
    redirects = 0
  ): Promise<number> {
    const real = await this.follow(path, 0, true);
    const { append } = this.base;
    if (!this.at(real) && append) {
      return this.based(
        [real],
        redirects,
        () => append.call(this.base, real, bytes, options),
        ([to], n) => this.append(to as string, bytes, options, n)
      );
    }
    throw errnoError('ENOTSUP', `${real}: appended by position on a mount`);
  }

  async pwrite(
    path: string,
    offset: number,
    bytes: Uint8Array,
    transfer = false,
    options?: PwriteOptions,
    redirects = 0
  ): Promise<void> {
    const real = await this.follow(path, 0, true);
    const found = this.at(real);
    const { pwrite } = this.base;
    if (!found && pwrite) {
      return this.based(
        [real],
        redirects,
        () => pwrite.call(this.base, real, offset, bytes, false, options),
        ([to], n) => this.pwrite(to as string, offset, bytes, transfer, options, n)
      );
    }
    if (!found)
      return this.base.writeFile(
        real,
        spliced(await this.base.readFileBuffer(real), offset, bytes)
      );
    const { mount, rel } = found;
    this.writable(mount, real);
    this.fits(mount, real, offset + bytes.length);
    this.table.forget(mount, real);
    if (mount.caps.sessions) {
      const session = this.table.session(mount, real, rel);
      const end = offset + bytes.length;
      await this.writeRuns(mount, await session.fh, offset, bytes, transfer);
      noteExtent(session.extents, offset, end);
      this.table.forget(mount, real);
      return;
    }
    const fh = (await mount.conn.call({
      op: 'open',
      path: rel,
      write: true,
      create: options?.create !== false,
      truncate: false,
      exclusive: false,
    })) as number;
    try {
      await this.writeRuns(mount, fh, offset, bytes, transfer);
    } finally {
      await mount.conn.call({ op: 'release', fh });
      this.table.forget(mount, real);
    }
  }

  private async writeRuns(
    mount: Mount,
    fh: number,
    offset: number,
    bytes: Uint8Array,
    transfer: boolean
  ): Promise<void> {
    const chunk = mount.caps.maxIo ?? DEFAULT_IO;
    for (let at = 0; at < bytes.length; at += chunk) {
      const part = handed(bytes, transfer, chunk) ? bytes : fresh(bytes, at, at + chunk);
      await mount.conn.call({ op: 'write', fh, offset: offset + at, bytes: part }, [part.buffer]);
    }
  }

  async truncate(path: string, size: number, redirects = 0): Promise<void> {
    const real = await this.follow(path);
    const found = this.at(real);
    const { truncate } = this.base;
    if (!found && truncate) {
      return this.based(
        [real],
        redirects,
        () => truncate.call(this.base, real, size),
        ([to], n) => this.truncate(to as string, size, n)
      );
    }
    if (!found?.mount.caps.ranges) {
      return this.writeFile(real, resized(await this.readFileBuffer(real), size));
    }
    const { mount, rel } = found;
    this.writable(mount, real);
    this.fits(mount, real, size);
    this.table.forget(mount, real);
    const session = this.table.writing(real);
    if (session) session.truncated = true;
    try {
      await mount.conn.call({ op: 'setattr', path: rel, size });
    } finally {
      this.table.forget(mount, real);
    }
  }

  async exists(path: string, redirects = 0): Promise<boolean> {
    if (!this.at(path)) {
      return this.based(
        [path],
        redirects,
        () => this.base.exists(path),
        ([to], n) => this.exists(to as string, n)
      );
    }
    try {
      await this.stat(path);
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw err;
    }
  }

  async copyFile(from: string, to: string, options: CopyOptions, redirects = 0): Promise<void> {
    const source = await realTarget(this, normalizePath(from));
    const a = this.at(source);
    const b = this.at(to);
    const copy = this.base.copyFile?.bind(this.base);
    if (!a && !b && copy) {
      return this.based(
        [source, to],
        redirects,
        () => copy(source, to, options),
        ([f, t], n) => this.copyFile(f as string, t as string, options, n)
      );
    }
    if (a?.mount !== b?.mount) throw errnoError('EXDEV', `${from} -> ${to}`);
    if (a) this.writable(a.mount, normalizePath(to));
    return copyByBytes(this, source, to, options);
  }

  async createExclusive(path: string, owner?: NewOwner, redirects = 0): Promise<void> {
    const exclusive = this.base.createExclusive?.bind(this.base);
    if (!this.at(path) && exclusive) {
      return this.based(
        [path],
        redirects,
        () => exclusive(path, owner),
        ([to], n) => this.createExclusive(to as string, owner, n)
      );
    }
    const there = await this.lstat(path).then(
      () => true,
      () => false
    );
    if (there) throw errnoError('EEXIST', path);
    await this.writeFile(path, new Uint8Array(0), owner);
  }

  async lstat(path: string, redirects = 0): Promise<FsStat> {
    const found = this.at(path);
    if (!found) {
      return this.based(
        [path],
        redirects,
        () => this.base.lstat(path),
        ([to], n) => this.lstat(to as string, n)
      );
    }
    const real = normalizePath(path);
    if (this.table.writing(real)?.truncated) await this.table.commit(real);
    return this.statWriting(
      await this.table.getattr(found.mount, real, found.rel, true),
      real,
      found.mount
    );
  }

  private statWriting(attr: DriverAttr, real: string, mount: Mount): FsStat {
    const ends = (this.table.writing(real)?.extents ?? []).map(([, end]) => end);
    return statOf({ ...attr, size: Math.max(attr.size, ...ends) }, real, mount);
  }

  async stat(path: string, redirects = 0): Promise<FsStat> {
    const real = await this.follow(path);
    if (this.at(real)) return this.lstat(real);
    return this.based(
      [real],
      redirects,
      () => this.base.stat(real),
      ([to], n) => this.stat(to as string, n)
    );
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

  async readdir(path: string, redirects = 0): Promise<string[]> {
    if (!this.at(path)) {
      return this.based(
        [path],
        redirects,
        () => this.base.readdir(path),
        ([to], n) => this.readdir(to as string, n)
      );
    }
    return (await this.entries(path)).list.map((e) => e.name);
  }

  async readdirStat(path: string, redirects = 0): Promise<Array<[string, FsStat | null]>> {
    if (!this.at(path)) {
      return this.based(
        [path],
        redirects,
        () => this.base.readdirStat(path),
        ([to], n) => this.readdirStat(to as string, n)
      );
    }
    const { real, mount, list } = await this.entries(path);
    return Promise.all(
      list.map(async (entry): Promise<[string, FsStat | null]> => {
        const child = normalizePath(`${real}/${entry.name}`);
        if (entry.attr && mount.caps.listingStats) {
          return [entry.name, this.statWriting(entry.attr, child, mount)];
        }
        return [entry.name, await this.lstat(child).catch(() => null)];
      })
    );
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; owner?: NewOwner } = {},
    redirects = 0
  ): Promise<void> {
    const found = this.at(path);
    if (!found) {
      return this.based(
        [path],
        redirects,
        () => this.base.mkdir(path, options),
        ([to], n) => this.mkdir(to as string, options, n)
      );
    }
    const { mount, rel } = found;
    const real = normalizePath(path);
    this.writable(mount, real);
    const { owner } = options;
    if (!options.recursive) {
      if (rel === '/') throw errnoError('EEXIST', real);
      const made = await this.driverOwner(found, real, owner, true);
      this.table.forget(mount, real);
      await mount.conn.call({ op: 'mkdir', path: rel, ...made });
      return;
    }
    const parts = rel.split('/').filter(Boolean);
    for (let n = 1; n <= parts.length; n++) {
      const sub = `/${parts.slice(0, n).join('/')}`;
      const full = normalizePath(`${mount.target}${sub}`);
      const exists = await this.table.getattr(mount, full, sub).catch(() => undefined);
      if (exists?.kind === 'directory') continue;
      if (exists) throw errnoError('ENOTDIR', full);
      const own = n === parts.length ? owner : owner && { ...owner, mode: owner.parents };
      const made = await this.driverOwner({ mount, rel: sub }, full, own, true);
      this.table.forget(mount, full);
      await mount.conn.call({ op: 'mkdir', path: sub, ...made });
    }
  }

  async rm(
    path: string,
    options: { recursive?: boolean; force?: boolean; file?: boolean } = {},
    redirects = 0
  ): Promise<void> {
    const found = this.at(path);
    if (!found && options.recursive && this.table.under(normalizePath(path)))
      return this.rmAround(normalizePath(path), options);
    if (!found) {
      return this.based(
        [path],
        redirects,
        () => this.base.rm(path, options),
        ([to], n) => this.rm(to as string, options, n)
      );
    }
    const { mount, rel } = found;
    const real = normalizePath(path);
    if (options.file && rel === '/') throw errnoError('EISDIR', real);
    if (rel === '/' && options.recursive) await this.rmEach(real, mount, rel, options);
    if (rel === '/') throw errnoError('EBUSY', `${real} is a mount point`);
    this.writable(mount, real);
    await this.table.commitUnder(real);
    let attr: DriverAttr;
    try {
      attr = await this.table.getattr(mount, real, rel);
    } catch (err) {
      if (options.force && (err as { code?: unknown }).code === 'ENOENT') return;
      throw err;
    }
    if (options.file && attr.kind === 'directory') throw errnoError('EISDIR', real);
    this.table.forget(mount, real);
    if (attr.kind === 'directory' && options.recursive) {
      await this.rmEach(real, mount, rel, { recursive: true, force: options.force ?? false });
      this.table.forget(mount, real);
    }
    await mount.conn.call({ op: attr.kind === 'directory' ? 'rmdir' : 'unlink', path: rel });
    this.table.forget(mount, real);
  }

  private async rmEach(
    real: string,
    mount: Mount,
    rel: string,
    options: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    let first: unknown;
    for (const entry of await this.table.readdir(mount, real, rel)) {
      await this.rm(joinName(real, entry.name), options).catch((err: unknown) => {
        first ??= err;
      });
    }
    if (first) throw first;
  }

  private async rmAround(
    path: string,
    options: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    let first: unknown;
    for (const name of await this.base.readdir(path)) {
      await this.rm(joinName(path, name), options).catch((err: unknown) => {
        first ??= err;
      });
    }
    throw first ?? errnoError('EBUSY', `${path} holds a mount point`);
  }

  async rename(from: string, to: string, redirects = 0): Promise<void> {
    const a = this.at(from);
    const b = this.at(to);
    if (!a && !b) {
      return this.based(
        [from, to],
        redirects,
        () => this.base.rename(from, to),
        ([f, t], n) => this.rename(f as string, t as string, n)
      );
    }
    if (!a || !b) {
      const [f, t] = await this.across(from, to, redirects);
      return this.rename(f, t, redirects + 1);
    }
    if (a.mount !== b.mount) throw errnoError('EXDEV', `${from} -> ${to}`);
    this.writable(a.mount, normalizePath(to));
    await this.table.commitUnder(from);
    await this.table.commitUnder(to);
    this.table.forget(a.mount, normalizePath(from));
    this.table.forget(a.mount, normalizePath(to));
    try {
      await a.mount.conn.call({ op: 'rename', from: a.rel, to: b.rel });
    } finally {
      this.table.forget(a.mount, normalizePath(from));
      this.table.forget(a.mount, normalizePath(to));
    }
  }

  links(path: string): boolean {
    const found = this.at(path);
    return found ? found.mount.caps.links === true : mayLink(this.base, path);
  }

  private async named(path: string): Promise<string> {
    const at = normalizePath(path);
    return joinName(await realDir(this, parentOf(at)), at.slice(at.lastIndexOf('/') + 1));
  }

  async link(source: string, target: string, follow = false): Promise<void> {
    const from = follow ? await realTarget(this, normalizePath(source)) : await this.named(source);
    const to = await this.named(target);
    const a = this.at(from);
    const b = this.at(to);
    if (!a && !b) return this.base.link(from, to);
    if (!a || !b || a.mount !== b.mount) throw errnoError('EXDEV', `${from} -> ${to}`);
    this.writable(a.mount, normalizePath(to));
    if (a.mount.caps.links) await this.lstat(from);
    if (!a.mount.caps.links) {
      throw errnoError('EPERM', `${from}: this file system has no hard links`);
    }
    await this.table.commitUnder(from);
    try {
      await a.mount.conn.call({ op: 'link', from: a.rel, to: b.rel });
    } finally {
      this.table.forget(a.mount, normalizePath(from));
      this.table.forget(a.mount, normalizePath(to));
    }
  }

  async symlink(target: string, path: string, owner?: NewOwner, redirects = 0): Promise<void> {
    const found = this.at(path);
    if (!found) {
      const make = () => this.base.symlink(target, path, owner);
      return this.based([path], redirects, make, ([to], n) =>
        this.symlink(target, to as string, owner, n)
      );
    }
    this.writable(found.mount, normalizePath(path));
    if (!found.mount.caps.symlinks)
      throw errnoError('EPERM', `${path}: this file system has no symlinks`);
    const link = owner && { uid: owner.uid, gid: owner.gid };
    const made = await this.driverOwner(found, normalizePath(path), link, false);
    this.table.forget(found.mount, normalizePath(path));
    await found.mount.conn.call({ op: 'symlink', target, path: found.rel, ...made });
  }

  async realpath(path: string, follow: boolean): Promise<string> {
    const { realpath } = this.base;
    if (!this.at(path) && realpath) {
      const real = await realpath.call(this.base, path, follow).catch((err: unknown) => {
        if (redirectOf(err)) return undefined;
        throw err;
      });
      if (real !== undefined && !this.at(real)) return real;
    }
    const real = follow ? await realTarget(this, normalizePath(path)) : await this.named(path);
    if (this.rejectLinks && real !== normalizePath(path)) throw errnoError('ELOOP', path);
    await this.lstat(real);
    return real;
  }

  async hasOwner(path: string): Promise<boolean> {
    if (this.at(path)) return true;
    return (await this.base.hasOwner?.(path)) ?? true;
  }

  async ancestry(path: string): Promise<Array<Perm | undefined>> {
    const names = chain(normalizePath(path));
    const first = names.findIndex((name) => this.at(name));
    if (first < 0) return ancestryOf(this.base, path);
    const out = first === 0 ? [] : await ancestryOf(this.base, names[first - 1] as string);
    if (out.length < first || out.some((perm) => perm?.link !== undefined)) return out;
    for (const name of names.slice(first)) {
      const st = await this.lstat(name).catch(() => undefined);
      if (!st) break;
      out.push(permOf(st, st.isSymbolicLink ? await this.readlink(name) : undefined));
      if (st.isSymbolicLink) break;
    }
    return out;
  }

  async readlink(path: string, redirects = 0): Promise<string> {
    const found = this.at(path);
    if (!found) {
      return this.based(
        [path],
        redirects,
        () => this.base.readlink(path),
        ([to], n) => this.readlink(to as string, n)
      );
    }
    return (await found.mount.conn.call({ op: 'readlink', path: found.rel })) as string;
  }

  async chown(path: string, change: OwnerChange, redirects = 0): Promise<void> {
    const real = change.follow === false || change.kind === 'new' ? path : await this.follow(path);
    const found = this.at(real);
    if (found) return this.chownMounted(found, normalizePath(real), change);
    const { chown } = this.base;
    if (!chown) throw errnoError('EPERM', path);
    return this.based(
      [real],
      redirects,
      () => chown.call(this.base, real, change),
      ([to], n) => this.chown(to as string, change, n)
    );
  }

  private async chownMounted(found: Located, real: string, change: OwnerChange): Promise<void> {
    const { mount, rel } = found;
    if (!mount.owners || !mount.caps.owners) {
      if (change.kind === 'new') return;
      throw errnoError('EPERM', `${real}: this file system keeps no owners`);
    }
    this.writable(mount, real);
    const { uid, gid, mode } = change;
    const fresh = change.kind === 'new' && ({ uid, gid, mode } as NewOwner);
    const set = (fresh ? await this.driverOwner(found, real, fresh, false) : change) as DriverOwner;
    this.table.forget(mount, real);
    const attrs = Object.entries({ uid: set.uid, gid: set.gid, mode: set.mode });
    await mount.conn.call({
      op: 'setattr',
      path: rel,
      ...Object.fromEntries(attrs.filter(([, value]) => value !== undefined)),
    });
  }

  async chmod(path: string, mode: number, redirects = 0): Promise<void> {
    const real = await this.follow(path);
    const found = this.at(real);
    if (!found) {
      return this.based(
        [real],
        redirects,
        () => this.base.chmod(real, mode),
        ([to], n) => this.chmod(to as string, mode, n)
      );
    }
    this.writable(found.mount, real);
    if (!found.mount.caps.chmod) return;
    this.table.forget(found.mount, real);
    await found.mount.conn.call({ op: 'setattr', path: found.rel, mode });
  }

  async utimes(path: string, atime: Date, mtime: Date, redirects = 0): Promise<void> {
    const real = await this.follow(path);
    const found = this.at(real);
    if (!found) {
      const set = () => this.base.utimes(real, atime, mtime);
      return this.based([real], redirects, set, ([to], n) =>
        this.utimes(to as string, atime, mtime, n)
      );
    }
    await this.setTimes(found, real, atime, mtime);
  }

  async lutimes(path: string, atime: Date, mtime: Date, redirects = 0): Promise<void> {
    const found = this.at(path);
    if (!found) {
      const set = () => lutimesOf(this.base, path, atime, mtime);
      return this.based([path], redirects, set, ([to], n) =>
        this.lutimes(to as string, atime, mtime, n)
      );
    }
    const real = normalizePath(path);
    if (!found.mount.caps.linkTimes && (await this.lstat(real)).isSymbolicLink) {
      throw errnoError('EOPNOTSUPP', path);
    }
    await this.setTimes(found, real, atime, mtime);
  }

  private async setTimes(found: Located, real: string, atime: Date, mtime: Date): Promise<void> {
    this.writable(found.mount, real);
    this.table.forget(found.mount, real);
    const times = { mtime: mtime.getTime(), atime: atime.getTime() };
    await found.mount.conn.call({ op: 'setattr', path: found.rel, ...times });
  }

  noLinks(): KernelFs {
    const noLinkBase = (this.base.noLinks as () => KernelFs).call(this.base);
    return view(this, { rejectLinks: true, base: noLinkBase }) as unknown as KernelFs;
  }
}
