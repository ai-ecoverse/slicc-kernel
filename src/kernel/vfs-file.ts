import { AsyncRangedFile, type AsyncRangedIo } from '../fs/ranged.ts';
import { fsError, type KernelFs, rangedOps } from '../fs/types.ts';
import type { KeptFile, UnlinkHolder } from '../fs/unlinked.ts';
import { KernelError, OpenFile } from './fd-table.ts';

export interface VfsFileFs extends Partial<AsyncRangedIo> {
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  stat?(path: string): Promise<{
    readonly?: boolean;
    maxFile?: number;
    size?: number;
    ranged?: boolean;
    version?: string;
  }>;
  readlink?(path: string): Promise<string>;
  lstat?(path: string): Promise<unknown>;
  realpath?(path: string, follow: boolean): Promise<string>;
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
    const st =
      io && !this.orphaned ? await this.fs.stat?.(this.path).catch(() => undefined) : undefined;
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
    this.cap ??= stat(this.path)
      .catch(() => stat(parent))
      .then(
        (st) => st.maxFile,
        () => undefined
      );
    return this.cap;
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

  createExclusive(path: string): Promise<void> {
    return this.onEntry(path, async () => {
      const node = this.byPath.get(path);
      const held = node ? await node.serial(async () => node.holds()) : false;
      if (held || (await present(this.fs, path))) throw fsError('EEXIST', path);
      await this.fs.writeFile(path, new Uint8Array(0));
    });
  }

  open(path: string, pin?: VersionPin, writable = false): VfsNode {
    let node = this.byPath.get(path);
    if (!node) {
      node = new VfsNode(this.fs, path, undefined, false, false, pin);
      this.byPath.set(path, node);
    }
    node.opens++;
    if (writable) node.writers++;
    return node;
  }

  adopt(path: string, contents: Uint8Array, dirty: boolean, writable = false): VfsNode {
    let node = this.byPath.get(path);
    if (!node) {
      node = new VfsNode(this.fs, path, contents, false, dirty);
      this.byPath.set(path, node);
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
    if (this.byPath.get(node.path) === node) this.byPath.delete(node.path);
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
    if (!node) {
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
    for (const [path, node] of this.byPath) {
      if (!within(path, prefix)) continue;
      node.revoke();
      this.byPath.delete(path);
    }
  }

  unlinked(path: string): void {
    for (const [held, node] of [...this.byPath]) {
      if (!within(held, path)) continue;
      node.orphaned = true;
      this.byPath.delete(held);
    }
  }

  renamed(from: string, to: string): void {
    if (from === to) return;
    const moved: VfsNode[] = [];
    for (const [p, node] of this.byPath) {
      if (within(p, from)) moved.push(node);
      else if (within(p, to)) {
        node.orphaned = true;
        this.byPath.delete(p);
      }
    }
    for (const node of moved) {
      this.byPath.delete(node.path);
      node.renamedTo(to + node.path.slice(from.length));
      this.byPath.set(node.path, node);
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

const MAX_LINKS = 40;

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

async function linkOf(fs: VfsFileFs, path: string): Promise<string | undefined> {
  return fs.readlink?.(path).catch(() => undefined);
}

interface Budget {
  hops: number;
}

async function realDir(fs: VfsFileFs, dir: string, budget: Budget = { hops: 0 }): Promise<string> {
  const queue = dir.split('/').filter(Boolean);
  let at = '/';
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      at = parentOf(at);
      continue;
    }
    const next = at === '/' ? `/${part}` : `${at}/${part}`;
    const link = await linkOf(fs, next);
    if (link === undefined) {
      at = next;
      continue;
    }
    if (budget.hops >= MAX_LINKS) throw fsError('ELOOP', dir);
    budget.hops++;
    queue.unshift(...link.split('/').filter(Boolean));
    if (link.startsWith('/')) at = '/';
  }
  return at;
}

function errCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

function joinName(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

async function realTarget(fs: VfsFileFs, path: string): Promise<string> {
  const budget: Budget = { hops: 0 };
  let dir = await realDir(fs, parentOf(path), budget);
  let name = path.slice(path.lastIndexOf('/') + 1);
  for (;;) {
    const link = await linkOf(fs, joinName(dir, name));
    if (link === undefined) break;
    if (budget.hops >= MAX_LINKS) throw fsError('ELOOP', path);
    budget.hops++;
    const target = link.startsWith('/') ? link : joinName(dir, link);
    dir = await realDir(fs, parentOf(target), budget);
    name = target.slice(target.lastIndexOf('/') + 1);
  }
  return joinName(dir, name);
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
    writeFile: (path, content) =>
      nodes.onEntry(fs.resolvePath('/', path), () => fs.writeFile(path, content)),
    createExclusive: async (path) =>
      nodes.createExclusive(await nodes.entryKey(fs.resolvePath('/', path))),
    symlink: (target, path) =>
      nodes.onEntry(fs.resolvePath('/', path), () => fs.symlink(target, path)),
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
        ? nodes.adopt(opts.path, opts.contents, opts.dirty === true, writable)
        : nodes.open(opts.path, opts.pin, writable);

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
