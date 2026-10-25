import { copyByBytes } from '../fs/copy.ts';
import { AsyncRangedFile, type AsyncRangedIo } from '../fs/ranged.ts';
import {
  fsError,
  type KernelFs,
  mayLink,
  type NewOwner,
  type OwnerChange,
  type PwriteOptions,
  rangedOps,
} from '../fs/types.ts';
import type { KeptFile, UnlinkHolder } from '../fs/unlinked.ts';
import { joinName, parentOf, realDir, realTarget } from '../fs/walk.ts';
import { KernelError, OpenFile } from './fd-table.ts';

export interface VfsFileFs extends Partial<AsyncRangedIo> {
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array, owner?: NewOwner): Promise<void>;
  mayChange?(path: string, follow: boolean, whole?: boolean): Promise<void>;
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
  append?(path: string, bytes: Uint8Array): Promise<number>;
  lstat?(path: string): Promise<unknown>;
  realpath?(path: string, follow: boolean): Promise<string>;
  chown?(path: string, change: OwnerChange): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  links?(path: string): boolean;
  exclusive?<T>(path: string, run: () => Promise<T>): Promise<T>;
}

const O_ACCMODE = 0o3;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;
const POSITIONAL_MS = 100;

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

  ino?: number;
}

export interface VersionPin {
  version: string;
  size: number;
}

export const WRITEBACK_MS = 250;

const UNREACHABLE: ReadonlySet<string> = new Set(['ENOMEDIUM', 'ENOTCONN', 'ENODEV', 'EIO']);

const WRITEBACK_COST_FACTOR = 10;

function isMissing(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === 'ENOENT') return true;
  return err instanceof Error && err.message.startsWith('ENOENT');
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export class VfsNode {
  fid: string | undefined;
  private data: Uint8Array | undefined;
  private ranged: AsyncRangedFile | undefined;
  private readonly pin: VersionPin | undefined;
  private length = 0;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();

  private writeBack: ReturnType<typeof setTimeout> | undefined;

  private writeBackCost = 0;

  private failed = false;

  private doubt = false;

  opens = 0;

  writers = 0;

  private missing = false;

  made = false;

  private revoked = false;

  private readonly fs: VfsFileFs;

  path: string;

  orphaned: boolean;

  id: string | undefined;

  ino: number | undefined;

  onDirty: (() => void) | undefined;

  onDirtyState: ((on: boolean) => void) | undefined;

  crowded: ((path: string) => boolean) | undefined;

  private counted = false;

  recount(): void {
    if (!this.onDirtyState) return;
    const on = this.dirty && !this.orphaned;
    if (on === this.counted) return;
    this.counted = on;
    this.onDirtyState?.(on);
  }

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

  private named = 0;

  byName<T>(op: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.named++;
      try {
        return await op();
      } finally {
        this.named--;
      }
    });
  }

  revoke(): void {
    this.revoked = true;
    clearTimeout(this.writeBack);
    this.writeBack = undefined;
    this.data = undefined;
    this.ranged = undefined;
  }

  private async prepare(onFd = this.named === 0): Promise<AsyncRangedFile | undefined> {
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
    await this.load(onFd);
    return undefined;
  }

  async keep(): Promise<void> {
    const ranged = await this.prepare(false);
    if (ranged) await this.followed(() => ranged.pin(), false);
  }

  readonly moving = new Set<Promise<void>>();

  private async followed<T>(op: () => Promise<T>, onFd = this.named === 0): Promise<T> {
    for (;;) {
      const at = this.path;
      try {
        return await op();
      } catch (err) {
        if (!isMissing(err)) throw err;
        while (this.moving.size > 0) await Promise.all(this.moving);
        if (this.path === at) throw onFd && !this.made ? new KernelError('EIO') : err;
      }
    }
  }

  async load(onFd = this.named === 0): Promise<Uint8Array> {
    if (this.revoked) throw new KernelError('EIO');
    while (!this.data) {
      const at = this.path;
      try {
        this.data = await this.fs.readFileBuffer(at);
      } catch (err) {
        if (!isMissing(err)) throw err;
        while (this.moving.size > 0) await Promise.all(this.moving);
        if (this.path !== at) continue;
        if (!this.made) throw new KernelError(onFd ? 'EIO' : 'ENOENT');
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

  reread(): void {
    if (this.dirty || this.orphaned || this.pin || this.revoked) return;
    this.data = undefined;
    this.ranged = undefined;
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
    if (this.peerHeld()) {
      const known = await this.exact();
      if (known !== undefined) return known;
    }
    const ranged = await this.prepare();
    return ranged ? ranged.size() : this.length;
  }

  private peered = false;

  private peerHeld(): boolean {
    if (this.orphaned || this.revoked || this.pin) return false;
    if (this.crowded?.(this.path) === true) this.peered = true;
    return this.peered;
  }

  private async exact(): Promise<number | undefined> {
    await this.flush();
    const { stat } = this.fs;
    const io = rangedOps(this.fs);
    if (!stat || !io) return undefined;
    const st = await this.followed(() => stat.call(this.fs, this.path));
    this.peered = this.crowded?.(this.path) === true;
    const size = st.size ?? 0;
    if (this.ranged) {
      if (size !== this.ranged.size()) {
        this.ranged = new AsyncRangedFile(io, this.path, size, st.version);
      }
      return undefined;
    }
    if (this.data && size !== this.length) this.data = undefined;
    return this.data ? undefined : size;
  }

  private landed(at: number, bytes: Uint8Array): void {
    if (this.ranged) {
      this.ranged.wrote(at, bytes.length);
      return;
    }
    if (!this.data) return;
    const end = at + bytes.length;
    const buf = this.ensure(end);
    if (at > this.length) buf.fill(0, this.length, at);
    buf.set(bytes, at);
    this.length = Math.max(this.length, end);
  }

  async pread(max: number, at: number): Promise<Uint8Array> {
    const ranged = await this.prepare();
    if (ranged) return this.followed(() => ranged.read(at, max));
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

  async append(bytes: Uint8Array): Promise<number> {
    const { append } = this.fs;
    const recently = performance.now() - this.positionalAt < POSITIONAL_MS;
    if (!append || this.orphaned || this.revoked || bytes.length === 0 || recently) {
      const at = await this.size();
      return at + (await this.pwrite(bytes, at));
    }
    await this.settled();
    await this.fits((await this.size()) + bytes.length);
    await this.flush();
    const end = await this.followed(() => append.call(this.fs, this.path, bytes)).catch(
      (err: unknown) => {
        if (!positional(err)) throw err;
        return undefined;
      }
    );
    if (end === undefined) {
      this.positionalAt = performance.now();
      const at = await this.size();
      return at + (await this.pwrite(bytes, at));
    }
    this.reread();
    return end;
  }

  private positionalAt = Number.NEGATIVE_INFINITY;

  shared(): void {
    this.positionalAt = Number.NEGATIVE_INFINITY;
  }

  async pwrite(bytes: Uint8Array, at: number): Promise<number> {
    if (bytes.length === 0) return 0;
    await this.settled();
    await this.fits(at + bytes.length);
    const io = this.peerHeld() ? rangedOps(this.fs) : undefined;
    if (io && at + bytes.length > (await this.size())) {
      const copy = bytes.slice();
      await this.followed(() => io.pwrite(this.path, at, copy, true));
      this.landed(at, bytes);
      return bytes.length;
    }
    const ranged = await this.prepare();
    if (ranged) {
      await this.followed(() => ranged.write(at, bytes));
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
    await this.settled();
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

  doubted(): void {
    if (this.dirty) this.failed = true;
    else if (!this.orphaned) this.doubt = true;
  }

  private async settled(): Promise<void> {
    if (this.failed) return this.flush();
    if (!this.doubt) return;
    const err = await this.fs.stat?.(this.path).then(
      () => undefined,
      (e: unknown) => e
    );
    if (UNREACHABLE.has((err as { code?: string } | undefined)?.code ?? '')) throw err;
    this.doubt = false;
  }

  private markDirty(): void {
    this.dirty = true;
    this.recount();
    if (!this.orphaned) this.onDirty?.();
    if (this.writeBack !== undefined || this.orphaned) return;
    const delay = Math.max(WRITEBACK_MS, this.writeBackCost * WRITEBACK_COST_FACTOR);
    this.writeBack = setTimeout(() => {
      this.writeBack = undefined;
      this.serial(() => this.flush()).catch(() => {
        this.failed = true;
      });
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
    if (!this.dirty || this.orphaned || !(this.data || this.ranged)) {
      this.failed = false;
      return;
    }
    this.dirty = false;
    const started = performance.now();
    try {
      await this.followed(() =>
        this.ranged
          ? this.ranged.flush()
          : this.fs.writeFile(this.path, (this.data as Uint8Array).slice(0, this.length))
      );
    } catch (err) {
      this.dirty = true;
      throw err;
    } finally {
      this.recount();
    }
    this.failed = false;
    this.writeBackCost = performance.now() - started;
  }
}

function positional(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOTSUP';
}

export class VfsNodes implements UnlinkHolder {
  private readonly byPath = new Map<string, VfsNode>();

  private readonly kept = new Map<VfsNode, KeptFile>();

  private readonly byId = new Map<string, VfsNode>();

  keepsOnDisk = false;

  changed: ((path: string) => void) | undefined;
  movedAway: ((from: string, to: string) => void) | undefined;
  opened: ((node: VfsNode) => void) | undefined;

  dirtied: ((delta: number) => void) | undefined;

  crowded: ((path: string) => boolean) | undefined;

  private readonly fs: VfsFileFs;

  readonly entries: Map<string, Promise<unknown>>;

  private readonly onClosed: ((path: string) => void) | undefined;

  constructor(
    fs: VfsFileFs,
    onClosed?: (path: string) => void,
    entries = new Map<string, Promise<unknown>>()
  ) {
    this.fs = fs;
    this.onClosed = onClosed;
    this.entries = entries;
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
      if (held) throw fsError('EEXIST', path);
      const exclusive = (this.fs as Partial<Pick<KernelFs, 'createExclusive'>>).createExclusive;
      if (exclusive) return exclusive.call(this.fs, path, owner);
      if (await present(this.fs, path)) throw fsError('EEXIST', path);
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
    this.reshaped();
    node.id = id;
    if (!this.byId.has(id)) this.byId.set(id, node);
  }

  private namesOf(node: VfsNode): string[] {
    const out: string[] = [];
    for (const [p, n] of this.byPath) if (n === node) out.push(p);
    return out;
  }

  private forget(node: VfsNode): void {
    this.reshaped();
    for (const p of this.namesOf(node)) this.byPath.delete(p);
    if (node.id !== undefined && this.byId.get(node.id) === node) this.byId.delete(node.id);
  }

  private orphan(node: VfsNode): void {
    node.orphaned = true;
    node.recount();
    this.forget(node);
  }

  private dropName(path: string, node: VfsNode): boolean {
    const others = this.namesOf(node).filter((p) => p !== path);
    if (others.length === 0) return false;
    this.byPath.delete(path);
    if (node.path === path) node.renamedTo(others[0] as string);
    return true;
  }

  shared(): void {
    for (const node of new Set(this.byPath.values())) node.shared();
  }

  holdsAny(): boolean {
    return this.byPath.size > 0;
  }

  private epoch = 0;

  private readonly plain = new Map<string, number>();

  reshaped(): void {
    this.epoch++;
    this.plain.clear();
  }

  plainAt(path: string): boolean {
    return this.plain.get(path) === this.epoch;
  }

  get shape(): number {
    return this.epoch;
  }

  notePlain(path: string, shape: number): void {
    if (shape !== this.epoch) return;
    if (this.plain.size >= 4096) this.plain.clear();
    this.plain.set(path, shape);
  }

  holdsName(name: string): boolean {
    for (const path of this.byPath.keys())
      if (path.slice(path.lastIndexOf('/') + 1) === name) return true;
    return false;
  }

  holdsLinked(): boolean {
    return this.byId.size > 0;
  }

  holdingId(id: string): VfsNode | undefined {
    const node = this.byId.get(id);
    return node && !node.orphaned ? node : undefined;
  }

  holding(path: string): VfsNode | undefined {
    if (this.byPath.size === 0) return undefined;
    const node = this.byPath.get(path);
    return node && !node.orphaned ? node : undefined;
  }

  private named(path: string, id: string | undefined): VfsNode | undefined {
    const node = this.byPath.get(path) ?? (id === undefined ? undefined : this.byId.get(id));
    if (node && !this.byPath.has(path)) this.byPath.set(path, node);
    return node;
  }

  private create(path: string, id: string | undefined, node: VfsNode): VfsNode {
    this.reshaped();
    node.onDirty = () => this.changed?.(node.path);
    node.onDirtyState = (on) => this.dirtied?.(on ? 1 : -1);
    node.crowded = (at) => this.crowded?.(at) === true;
    node.recount();
    this.byPath.set(path, node);
    if (id !== undefined) this.know(node, id);
    return node;
  }

  open(path: string, pin?: VersionPin, writable = false, id?: string, ino?: number): VfsNode {
    const found = this.named(path, id);
    const same = !found || ino === undefined || found.ino === undefined || found.ino === ino;
    if (found && !same) this.orphan(found);
    const node =
      (same ? found : undefined) ??
      this.create(path, id, new VfsNode(this.fs, path, undefined, false, false, pin));
    node.ino ??= ino;
    node.opens++;
    if (writable) node.writers++;
    if (node.opens === 1) this.opened?.(node);
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
    if (node.opens === 1) this.opened?.(node);
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

  heldIds(): Array<[string, string | undefined]> {
    const out: Array<[string, string | undefined]> = [];
    for (const [path, node] of this.byPath) if (!this.kept.has(node)) out.push([path, node.fid]);
    return out;
  }

  holdsAt(path: string): boolean {
    return this.byPath.has(path);
  }

  async bindIds(id: (path: string) => Promise<string | undefined> | undefined): Promise<void> {
    for (const [path, node] of [...this.byPath]) {
      if (node.fid !== undefined || this.kept.has(node)) continue;
      node.fid = await id(path)?.catch(() => undefined);
    }
  }

  keepBound(paths: readonly string[], fid: string | undefined, file: KeptFile): boolean {
    for (const at of paths) {
      const node = this.byPath.get(at);
      if (!node || this.kept.has(node) || node.fid !== fid) continue;
      this.byPath.delete(at);
      node.renamedTo(file.hidden);
      this.byPath.set(file.hidden, node);
      this.kept.set(node, file);
      return true;
    }
    return false;
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

  moving(path: string): () => void {
    const node = this.byPath.get(path);
    if (!node) return () => undefined;
    const { promise, resolve } = Promise.withResolvers<void>();
    node.moving.add(promise);
    return () => {
      node.moving.delete(promise);
      resolve();
    };
  }

  unkeep(path: string, file: KeptFile): void {
    const node = this.byPath.get(file.hidden);
    if (!node) return;
    this.byPath.delete(file.hidden);
    node.renamedTo(path);
    this.byPath.set(path, node);
    this.kept.delete(node);
  }

  rewritten(path: string): void {
    this.byPath.get(path)?.reread();
  }

  rewrittenUnder(tree: string): void {
    for (const [p, node] of this.byPath) if (within(p, tree)) node.reread();
  }

  doubted(path: string): void {
    for (const [p, node] of this.byPath) if (within(p, path)) node.doubted();
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

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

async function byRealPath(fs: KernelFs, nodes: VfsNodes, at: string) {
  const real = await fs.realpath?.(at, true).catch(() => undefined);
  return real === undefined || real === at ? undefined : nodes.holding(real);
}

async function aliasOf(fs: KernelFs, nodes: VfsNodes, at: string): Promise<VfsNode | undefined> {
  if (nodes.holdsName(baseName(at))) {
    const named = await byRealPath(fs, nodes, at);
    if (named) return named;
  }
  const st = await fs.lstat(at).catch(() => undefined);
  if (!st) return undefined;
  if (st.isSymbolicLink) return byRealPath(fs, nodes, at);
  if (st.ino === undefined || (st.nlink ?? 1) < 2 || !nodes.holdsLinked()) return undefined;
  return nodes.holdingId(`${st.dev ?? 0}:${st.ino}`);
}

async function heldAt(fs: KernelFs, nodes: VfsNodes, at: string): Promise<VfsNode | undefined> {
  const held = nodes.holding(at);
  if (held || !nodes.holdsAny() || nodes.plainAt(at)) return held;
  const shape = nodes.shape;
  const found = await aliasOf(fs, nodes, at);
  if (!found) nodes.notePlain(at, shape);
  return found;
}

function heldIo(fs: KernelFs, nodes: VfsNodes, changed: (path: string) => void): Partial<KernelFs> {
  const ranged = rangedOps(fs);
  const node = (path: string) => heldAt(fs, nodes, fs.resolvePath('/', path));
  const write = async <T>(
    path: string,
    op: (held: VfsNode) => Promise<T>,
    fallback: () => Promise<T>
  ) => {
    const held = await node(path);
    if (!held) return fallback();
    const out = await held.byName(async () => {
      const done = await op(held);
      await held.flush();
      return done;
    });
    changed(fs.resolvePath('/', path));
    if (held.path !== fs.resolvePath('/', path)) changed(held.path);
    return out;
  };
  return {
    append: (path: string, bytes: Uint8Array) =>
      write(
        path,
        (held) => held.append(bytes),
        async () => {
          const end = await fs.append?.(path, bytes, { alone: true }).catch((err: unknown) => {
            if (!positional(err)) throw err;
            return undefined;
          });
          if (end !== undefined) return end;
          const at = (await fs.stat(path)).size;
          if (ranged) await ranged.pwrite(path, at, bytes, true);
          else {
            const whole = new Uint8Array(at + bytes.length);
            whole.set(await fs.readFileBuffer(path));
            whole.set(bytes, at);
            await fs.writeFile(path, whole);
          }
          return at + bytes.length;
        }
      ),
    async stat(path) {
      const st = await fs.stat(path);
      const held = st.isFile ? await node(path) : undefined;
      return held ? { ...st, size: await held.byName(() => held.size()) } : st;
    },
    async lstat(path) {
      const st = await fs.lstat(path);
      const held = st.isFile && !st.isSymbolicLink ? await node(path) : undefined;
      return held ? { ...st, size: await held.byName(() => held.size()) } : st;
    },
    async readFileBuffer(path) {
      const held = await node(path);
      if (!held) return fs.readFileBuffer(path);
      return held.byName(async () => held.pread(await held.size(), 0));
    },
    ...(ranged
      ? {
          pread: async (path: string, at: number, n: number, version?: string) => {
            const held = await node(path);
            return held ? held.byName(() => held.pread(n, at)) : ranged.pread(path, at, n, version);
          },
          pwrite: (
            path: string,
            at: number,
            bytes: Uint8Array,
            transfer?: boolean,
            options?: PwriteOptions
          ) =>
            write(
              path,
              async (held) => void (await held.pwrite(bytes, at)),
              () => ranged.pwrite(path, at, bytes, transfer, options)
            ),
          truncate: (path: string, size: number) =>
            write(
              path,
              (held) => held.truncate(size),
              () => ranged.truncate(path, size)
            ),
        }
      : {}),
  };
}

export function keepingOpen(
  fs: KernelFs,
  nodes: VfsNodes,
  changed: (path: string) => void = () => {}
): KernelFs {
  return {
    ...fs,
    ...heldIo(fs, nodes, changed),
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
        nodes.movedAway?.(a, b);
      });
    },
    writeFile: async (path, content, owner) => {
      const at = fs.resolvePath('/', path);
      const held = await heldAt(fs, nodes, at);
      if (!held) return nodes.onEntry(at, () => fs.writeFile(path, content, owner));
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      return held.byName(async () => {
        await held.truncate(0);
        await held.pwrite(bytes, 0);
        await held.flush();
        changed(at);
        if (held.path !== at) changed(held.path);
      });
    },
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
    ...(fs.copyFile
      ? {
          async copyFile(from, to, options) {
            const source = await nodes.targetKey(fs.resolvePath('/', from));
            await nodes.flush(source);
            await nodes.flushLinked(source);
            const at = fs.resolvePath('/', to);
            const key = await nodes.entryKey(at);
            if (await heldAt(fs, nodes, at)) return copyByBytes(this, from, to, options);
            await nodes.onEntry(key, () => fs.copyFile?.(from, to, options) as Promise<void>);
          },
        }
      : {}),
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
        : nodes.open(opts.path, opts.pin, writable, opts.id, opts.ino);

  let openError: { err: unknown } | undefined;
  const atOpen = (op: () => Promise<void>): void => {
    void node.serial(op).catch((err: unknown) => {
      openError ??= { err };
    });
  };
  if (opts.create || opts.truncate) node.made = true;
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
            if (opts.flags & O_APPEND) offset = await node.append(bytes);
            else offset += await node.pwrite(bytes, offset);
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
    reread: () => serial(async () => node.reread()),

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
