import { AsyncRangedFile, type AsyncRangedIo } from '../fs/ranged.ts';
import {
  fsError,
  type KernelFs,
  mayLink,
  type NewOwner,
  type OwnerChange,
  rangedOps,
} from '../fs/types.ts';
import type { KeptFile, UnlinkHolder } from '../fs/unlinked.ts';
import { joinName, parentOf, realDir, realTarget } from '../fs/walk.ts';
import { KernelError, OpenFile } from './fd-table.ts';

export interface VfsFileFs extends Partial<AsyncRangedIo> {
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array, owner?: NewOwner): Promise<void>;
  mayChange?(path: string, follow: boolean): Promise<void>;
  stat?(path: string): Promise<{
    readonly?: boolean;
    maxFile?: number;
    size?: number;
    ranged?: boolean;
    version?: string;
    ino?: number;
    dev?: number;
    nlink?: number;
  }>;
  readlink?(path: string): Promise<string>;
  lstat?(path: string): Promise<unknown>;
  realpath?(path: string, follow: boolean): Promise<string>;
  chown?(path: string, change: OwnerChange): Promise<void>;
  links?(path: string): boolean;
  exclusive?<T>(path: string, run: () => Promise<T>): Promise<T>;
}

const O_ACCMODE = 0o3;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

export interface VfsFileOptions {
  path: string;

  flags: number;

  position: number;

  contents?: Uint8Array;

  orphan?: boolean;

  dirty?: boolean;

  pin?: VersionPin;

  truncate?: boolean;

  create?: boolean;

  id?: string;
}

export interface VersionPin {
  version: string;
  size: number;
}

export const WRITEBACK_MS = 250;

const WRITEBACK_COST_FACTOR = 10;

function isMissing(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === 'ENOENT') return true;
  return err instanceof Error && err.message.startsWith('ENOENT');
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export class VfsNode {
  private data: Uint8Array | undefined;
  private ranged: AsyncRangedFile | undefined;
  private readonly pin: VersionPin | undefined;
  private length = 0;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();

  private writeBack: ReturnType<typeof setTimeout> | undefined;

  private writeBackCost = 0;

  opens = 0;

  writers = 0;

  private missing = false;

  private revoked = false;

  private readonly fs: VfsFileFs;

  path: string;

  orphaned: boolean;

  id: string | undefined;

  constructor(
    fs: VfsFileFs,

    path: string,

    contents?: Uint8Array,

    orphaned: boolean = false,

    dirty = false,

    pin?: VersionPin
  ) {
    this.fs = fs;
    this.pin = pin;

    this.path = path;

    this.orphaned = orphaned;
    if (contents !== undefined) this.data = new Uint8Array(contents);
    else if (orphaned) this.data = new Uint8Array(0);
    this.length = this.data?.length ?? 0;
    if (dirty && contents !== undefined) this.markDirty();
  }

  serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  revoke(): void {
    this.revoked = true;
    clearTimeout(this.writeBack);
    this.writeBack = undefined;
    this.data = undefined;
    this.ranged = undefined;
  }

  private async prepare(): Promise<AsyncRangedFile | undefined> {
    if (this.revoked) throw new KernelError('EIO');
    if (this.ranged || this.data) return this.ranged;
    const io = rangedOps(this.fs);
    if (io && this.pin && !this.orphaned) {
      this.ranged = new AsyncRangedFile(io, this.path, this.pin.size, this.pin.version);
      return this.ranged;
    }
    const at = this.path;
    const st = io && !this.orphaned ? await this.fs.stat?.(at).catch(() => undefined) : undefined;
    this.note(at, st);
    if (io && st?.ranged) {
      this.ranged = new AsyncRangedFile(io, this.path, st.size ?? 0, st.version);
      return this.ranged;
    }
    await this.load();
    return undefined;
  }

  async keep(): Promise<void> {
    const ranged = await this.prepare();
    await ranged?.pin();
  }

  async load(): Promise<Uint8Array> {
    if (this.revoked) throw new KernelError('EIO');
    if (!this.data) {
      try {
        this.data = await this.fs.readFileBuffer(this.path);
      } catch (err) {
        if (!isMissing(err)) throw err;
        this.data = new Uint8Array(0);
        this.missing = true;
      }
      this.length = this.data.length;
    }
    return this.data;
  }

  holds(): boolean {
    return this.dirty;
  }

  replace(contents: Uint8Array): void {
    this.ranged = undefined;
    this.data = new Uint8Array(contents);
    this.length = this.data.length;
    this.missing = false;
    this.markDirty();
  }

  async materialize(): Promise<void> {
    if (await this.prepare()) return;
    if (!this.missing || this.orphaned) return;
    this.missing = false;
    await this.fs.writeFile(this.path, this.data?.slice(0, this.length) ?? new Uint8Array(0));
    if (!this.dirty) this.data = undefined;
  }

  async size(): Promise<number> {
    const ranged = await this.prepare();
    return ranged ? ranged.size() : this.length;
  }

  async pread(max: number, at: number): Promise<Uint8Array> {
    const ranged = await this.prepare();
    if (ranged) return ranged.read(at, max);
    const bytes = await this.load();
    const n = Math.max(0, Math.min(max, this.length - at));
    return bytes.slice(at, at + n);
  }

  private cap: Promise<number | undefined> | undefined;

  limit(): Promise<number | undefined> {
    if (this.cap !== undefined) return this.cap;
    const stat = this.fs.stat?.bind(this.fs);
    if (!stat || this.orphaned) return Promise.resolve(undefined);
    const parent = this.path.slice(0, this.path.lastIndexOf('/')) || '/';
    const at = this.path;
    this.cap ??= stat(at)
      .then((st) => {
        this.note(at, st);
        return st;
      })
      .catch(() => stat(parent))
      .then(
        (st) => st.maxFile,
        () => undefined
      );
    return this.cap;
  }

  private seen: { path: string; ino: number } | undefined;

  private note(path: string, st: { ino?: number } | undefined): void {
    if (st?.ino !== undefined) this.seen = { path, ino: st.ino };
  }

  known(): number | undefined {
    return this.seen?.path === this.path && !this.orphaned ? this.seen.ino : undefined;
  }

  private async fits(end: number): Promise<void> {
    const max = await this.limit();
    if (max !== undefined && end > max) throw new KernelError('EFBIG');
  }

  renamedTo(path: string): void {
    this.path = path;
    if (this.ranged) this.ranged.path = path;
    this.cap = undefined;
  }

  async pwrite(bytes: Uint8Array, at: number): Promise<number> {
    if (bytes.length === 0) return 0;
    await this.fits(at + bytes.length);
    const ranged = await this.prepare();
    if (ranged) {
      await ranged.write(at, bytes);
      this.markDirty();
      return bytes.length;
    }
    const buf = this.ensure(at + bytes.length);
    if (at > this.length) buf.fill(0, this.length, at);
    buf.set(bytes, at);
    this.length = Math.max(this.length, at + bytes.length);
    this.markDirty();
    return bytes.length;
  }

  async truncate(size: number): Promise<void> {
    await this.fits(size);
    const ranged = await this.prepare();
    if (ranged) {
      ranged.truncate(size);
      this.markDirty();
      return;
    }
    const buf = this.ensure(size);
    if (size > this.length) buf.fill(0, this.length, size);
    this.length = size;
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.writeBack !== undefined || this.orphaned) return;
    const delay = Math.max(WRITEBACK_MS, this.writeBackCost * WRITEBACK_COST_FACTOR);
    this.writeBack = setTimeout(() => {
      this.writeBack = undefined;
      this.serial(() => this.flush()).catch(() => undefined);
    }, delay);
  }

  private ensure(need: number): Uint8Array {
    const cur = this.data ?? new Uint8Array(0);
    if (cur.length >= need) return cur;
    const grown = new Uint8Array(Math.max(need, cur.length * 2, 256));
    grown.set(cur.subarray(0, this.length));
    this.data = grown;
    return grown;
  }

  async flush(): Promise<void> {
    if (this.revoked && this.dirty) throw new KernelError('EIO');
    if (!this.dirty || this.orphaned || !(this.data || this.ranged)) return;
    this.dirty = false;
    const started = performance.now();
    try {
      if (this.ranged) await this.ranged.flush();
      else await this.fs.writeFile(this.path, (this.data as Uint8Array).slice(0, this.length));
    } catch (err) {
      this.dirty = true;
      throw err;
    }
    this.writeBackCost = performance.now() - started;
  }
}

export class VfsNodes implements UnlinkHolder {
  private readonly byPath = new Map<string, VfsNode>();

  private readonly kept = new Map<VfsNode, KeptFile>();

  private readonly byId = new Map<string, VfsNode>();

  keepsOnDisk = false;

  private readonly fs: VfsFileFs;

  private readonly entries = new Map<string, Promise<unknown>>();

  private readonly onClosed: ((path: string) => void) | undefined;

  constructor(fs: VfsFileFs, onClosed?: (path: string) => void) {
    this.fs = fs;
    this.onClosed = onClosed;
  }

  async onEntry<T>(path: string, op: () => Promise<T>): Promise<T> {
    const key = await this.entryKey(path);
    const run = (this.entries.get(key) ?? Promise.resolve()).then(op);
    const tail = run.catch(() => undefined);
    this.entries.set(key, tail);
    void tail.then(() => {
      if (this.entries.get(key) === tail) this.entries.delete(key);
    });
    return run;
  }

  async entryKey(path: string): Promise<string> {
    const parent = parentOf(path);
    const dir = await this.real(parent, true, () => realDir(this.fs, parent));
    return joinName(dir, path.slice(path.lastIndexOf('/') + 1));
  }

  targetKey(path: string): Promise<string> {
    return this.real(path, true, () => realTarget(this.fs, path));
  }

  private async real(path: string, follow: boolean, walk: () => Promise<string>): Promise<string> {
    if (this.fs.realpath) {
      try {
        return await this.fs.realpath(path, follow);
      } catch (err) {
        if (errCode(err) === 'ELOOP') throw err;
      }
    }
    return walk();
  }

  createExclusive(path: string, owner?: NewOwner): Promise<void> {
    return this.onEntry(path, async () => {
      const node = this.byPath.get(path);
      const held = node ? await node.serial(async () => node.holds()) : false;
      if (held || (await present(this.fs, path))) throw fsError('EEXIST', path);
      await this.fs.writeFile(path, new Uint8Array(0), owner);
    });
  }

  private async identity(path: string): Promise<string | undefined> {
    const st = await this.fs.stat?.(path).catch(() => undefined);
    if (!st || st.ino === undefined || (st.nlink ?? 1) < 2) return undefined;
    return `${st.dev ?? 0}:${st.ino}`;
  }

  async identify(path: string): Promise<string | undefined> {
    return this.byPath.has(path) || !mayLink(this.fs, path) ? undefined : this.identity(path);
  }

  async flushLinked(path: string): Promise<void> {
    if (this.byId.size === 0 || !mayLink(this.fs, path)) return;
    const id = await this.identity(path);
    const node = id === undefined ? undefined : this.byId.get(id);
    if (node) await node.serial(() => node.flush());
  }

  async linked(from: string, to: string): Promise<void> {
    const node = this.byPath.get(from);
    if (!node || node.orphaned) return;
    const id = node.id ?? (await this.identity(to));
    if (id === undefined || node.orphaned) return;
    this.know(node, id);
    if (!this.byPath.has(to)) this.byPath.set(to, node);
  }

  private know(node: VfsNode, id: string): void {
    node.id = id;
    if (!this.byId.has(id)) this.byId.set(id, node);
  }

  private namesOf(node: VfsNode): string[] {
    const out: string[] = [];
    for (const [p, n] of this.byPath) if (n === node) out.push(p);
    return out;
  }

  private forget(node: VfsNode): void {
    for (const p of this.namesOf(node)) this.byPath.delete(p);
    if (node.id !== undefined && this.byId.get(node.id) === node) this.byId.delete(node.id);
  }

  private orphan(node: VfsNode): void {
    node.orphaned = true;
    this.forget(node);
  }

  private dropName(path: string, node: VfsNode): boolean {
    const others = this.namesOf(node).filter((p) => p !== path);
    if (others.length === 0) return false;
    this.byPath.delete(path);
    if (node.path === path) node.renamedTo(others[0] as string);
    return true;
  }

  private named(path: string, id: string | undefined): VfsNode | undefined {
    const node = this.byPath.get(path) ?? (id === undefined ? undefined : this.byId.get(id));
    if (node && !this.byPath.has(path)) this.byPath.set(path, node);
    return node;
  }

  private create(path: string, id: string | undefined, node: VfsNode): VfsNode {
    this.byPath.set(path, node);
    if (id !== undefined) this.know(node, id);
    return node;
  }

  open(path: string, pin?: VersionPin, writable = false, id?: string): VfsNode {
    const node =
      this.named(path, id) ??
      this.create(path, id, new VfsNode(this.fs, path, undefined, false, false, pin));
    node.opens++;
    if (writable) node.writers++;
    return node;
  }

  adopt(
    path: string,
    contents: Uint8Array,
    dirty: boolean,
    writable = false,
    id?: string
  ): VfsNode {
    let node = this.named(path, id);
    if (!node) {
      node = this.create(path, id, new VfsNode(this.fs, path, contents, false, dirty));
    } else if (dirty) {
      node.replace(contents);
    }
    node.opens++;
    if (writable) node.writers++;
    return node;
  }

  holds(prefix: string): boolean {
    for (const path of this.byPath.keys()) if (within(path, prefix)) return true;
    return false;
  }

  writes(prefix: string): boolean {
    for (const [path, node] of this.byPath)
      if (node.writers > 0 && within(path, prefix)) return true;
    return false;
  }

  closed(node: VfsNode, writable = false): void {
    node.opens--;
    if (writable) node.writers--;
    if (node.opens > 0) {
      if (writable && node.writers === 0) this.onClosed?.(node.path);
      return;
    }
    this.forget(node);
    this.kept.get(node)?.release();
    this.kept.delete(node);
    this.onClosed?.(node.path);
  }

  held(): Iterable<string> {
    return this.byPath.keys();
  }

  owns(): boolean {
    return false;
  }

  isKept(): boolean {
    return false;
  }

  keep(path: string, file: KeptFile): void {
    const node = this.byPath.get(path);
    if (!node || this.dropName(path, node)) {
      file.release();
      return;
    }
    this.byPath.delete(path);
    node.renamedTo(file.hidden);
    this.byPath.set(file.hidden, node);
    this.kept.set(node, file);
  }

  unkeep(path: string, file: KeptFile): void {
    const node = this.byPath.get(file.hidden);
    if (!node) return;
    this.byPath.delete(file.hidden);
    node.renamedTo(path);
    this.byPath.set(path, node);
    this.kept.delete(node);
  }

  async flush(path: string): Promise<void> {
    for (const [p, node] of this.byPath) if (within(p, path)) await node.serial(() => node.flush());
  }

  async unlinking(path: string): Promise<void> {
    for (const [held, node] of [...this.byPath]) {
      if (!within(held, path)) continue;
      await node.serial(async () => {
        await Promise.all([this.keepsOnDisk || node.keep(), node.limit()]);
      });
    }
  }

  revoke(prefix: string): void {
    for (const [path, node] of [...this.byPath]) {
      if (!within(path, prefix)) continue;
      node.revoke();
      this.forget(node);
    }
  }

  unlinked(path: string): void {
    for (const [held, node] of [...this.byPath]) {
      if (!within(held, path) || this.byPath.get(held) !== node) continue;
      if (!this.dropName(held, node)) this.orphan(node);
    }
  }

  renamed(from: string, to: string): void {
    if (from === to) return;
    const moved: Array<[string, VfsNode]> = [];
    for (const [p, node] of [...this.byPath]) {
      if (within(p, from)) moved.push([p, node]);
      else if (within(p, to) && this.byPath.get(p) === node && !this.dropName(p, node)) {
        this.orphan(node);
      }
    }
    for (const [p] of moved) this.byPath.delete(p);
    for (const [p, node] of moved) {
      const next = to + p.slice(from.length);
      if (node.path === p) node.renamedTo(next);
      this.byPath.set(next, node);
    }
  }
}

export async function present(fs: VfsFileFs, path: string, follow = false): Promise<boolean> {
  const look = (follow ? undefined : fs.lstat) ?? fs.stat;
  try {
    await (look ? look.call(fs, path) : fs.readFileBuffer(path));
    return true;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return false;
    throw err;
  }
}

function errCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

async function targetDir(fs: VfsFileFs, path: string): Promise<string> {
  return parentOf(await realTarget(fs, path).catch(() => path));
}

export async function refuseReadonly(
  fs: VfsFileFs,
  path: string,
  flags: number,
  opts: { create?: boolean; truncate?: boolean } = {}
): Promise<void> {
  const writes = (flags & O_ACCMODE) !== 0 || opts.truncate === true;
  if ((!writes && !opts.create) || !fs.stat) return;
  const stat = (p: string) =>
    fs.stat?.(p).catch((err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (isMissing(err) || typeof code !== 'string') return undefined;
      throw err;
    });
  const own = await stat(path);
  if (own && !writes) return;
  const st = own ?? (await stat(await targetDir(fs, path)));
  if (st?.readonly) throw new KernelError('EROFS');
}

export function keepingOpen(fs: KernelFs, nodes: VfsNodes): KernelFs {
  return {
    ...fs,
    async exclusive(path, run, follow = true) {
      const at = fs.resolvePath('/', path);
      const key = follow ? nodes.targetKey(at) : nodes.entryKey(at);
      const locked = await key.catch(() => at);
      return nodes.onEntry(locked, () =>
        run({
          writeFile: (p, content, owner) => fs.writeFile(p, content, owner),
          direct: locked === at,
        })
      );
    },
    async rm(path, options) {
      const at = await nodes.entryKey(fs.resolvePath('/', path));
      await nodes.unlinking(at);
      await fs.rm(path, options);
      nodes.unlinked(at);
    },
    async rename(from, to) {
      const a = await nodes.entryKey(fs.resolvePath('/', from));
      const b = await nodes.entryKey(fs.resolvePath('/', to));
      return nodes.onEntry(b, async () => {
        await nodes.unlinking(b);
        await fs.rename(from, to);
        nodes.renamed(a, b);
      });
    },
    writeFile: (path, content, owner) =>
      nodes.onEntry(fs.resolvePath('/', path), () => fs.writeFile(path, content, owner)),
    createExclusive: async (path, owner) =>
      nodes.createExclusive(await nodes.entryKey(fs.resolvePath('/', path)), owner),
    symlink: (target, path, owner) =>
      nodes.onEntry(fs.resolvePath('/', path), () => fs.symlink(target, path, owner)),
    links: (path) => mayLink(fs, path),
    link: async (from, to, follow) => {
      const source = fs.resolvePath('/', from);
      const at = await (follow ? nodes.targetKey(source) : nodes.entryKey(source));
      await nodes.flush(at);
      await nodes.flushLinked(at);
      const key = await nodes.entryKey(fs.resolvePath('/', to));
      await nodes.onEntry(key, () => fs.link(from, to, follow));
      await nodes.linked(at, key);
    },
    mkdir: (path, options) =>
      nodes.onEntry(fs.resolvePath('/', path), () => fs.mkdir(path, options)),
  };
}

export function vfsFile(fs: VfsFileFs, opts: VfsFileOptions, nodes?: VfsNodes): OpenFile {
  const access = opts.flags & O_ACCMODE;
  const readable = access !== O_WRONLY;
  const writable = access === O_WRONLY || access === O_RDWR;

  const node =
    !nodes || opts.orphan
      ? new VfsNode(fs, opts.path, opts.contents, opts.orphan === true, opts.dirty === true)
      : opts.contents !== undefined
        ? nodes.adopt(opts.path, opts.contents, opts.dirty === true, writable, opts.id)
        : nodes.open(opts.path, opts.pin, writable, opts.id);

  let openError: { err: unknown } | undefined;
  const atOpen = (op: () => Promise<void>): void => {
    void node.serial(op).catch((err: unknown) => {
      openError ??= { err };
    });
  };
  if (opts.create) atOpen(() => node.materialize());
  if (opts.truncate) atOpen(() => node.truncate(0));
  const takeOpenError = (): void => {
    if (!openError) return;
    const { err } = openError;
    openError = undefined;
    throw err;
  };
  let offset = opts.position;
  const serial = <T>(op: () => Promise<T>) =>
    node.serial(() => {
      takeOpenError();
      return op();
    });

  return new OpenFile({
    read: readable
      ? (max) =>
          serial(async () => {
            const out = await node.pread(max, offset);
            offset += out.length;
            return out;
          })
      : undefined,
    write: writable
      ? (bytes) =>
          serial(async () => {
            if (opts.flags & O_APPEND) offset = await node.size();
            offset += await node.pwrite(bytes, offset);
            return bytes.length;
          })
      : undefined,
    seek: (to, whence) =>
      serial(async () => {
        let base = 0;
        if (whence === SEEK_CUR) base = offset;
        else if (whence === SEEK_END) base = await node.size();
        else if (whence !== SEEK_SET) throw new KernelError('EINVAL');
        if (base + to < 0) throw new KernelError('EINVAL');
        offset = base + to;
        return offset;
      }),
    pread: (max, at) =>
      serial(() => {
        if (!readable) throw new KernelError('EBADF');
        return node.pread(max, at);
      }),
    pwrite: (bytes, at) =>
      serial(() => {
        if (!writable) throw new KernelError('EBADF');
        return node.pwrite(bytes, at);
      }),
    resize: (size) =>
      serial(() => {
        if (!writable) throw new KernelError('EBADF');
        return node.truncate(size);
      }),
    stat: () =>
      serial(async () => ({
        path: node.path,
        size: await node.size(),
        ...(node.orphaned ? { orphan: true as const } : {}),
      })),
    known: () => node.known(),
    flush: () => serial(() => node.flush()),

    close: () =>
      node.serial(async () => {
        try {
          takeOpenError();
          await node.flush();
        } finally {
          nodes?.closed(node, writable);
        }
      }),
  });
}
