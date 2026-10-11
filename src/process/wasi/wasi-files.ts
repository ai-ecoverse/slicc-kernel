import { RangedFile } from '../../fs/ranged.ts';
import type { DeviceAccess, KernelFdKind } from '../../kernel/fd-table.ts';
import type {
  SyncFsBridgeStat,
  SyncFsFileIo,
  SyncFsPosixBridge,
} from '../../realm/sync-fs-wire.ts';

export class WasiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class FileBuffer {
  private data: Uint8Array | undefined;
  private length = 0;
  private dirty = false;

  private whole = false;
  private from = Infinity;
  private to = 0;

  private orphaned = false;

  opens = 0;

  private readonly fs: SyncFsFileIo;
  private where: string;
  private readonly ranged: RangedFile | undefined;

  maxFile: number | undefined;
  handle: number | undefined;

  constructor(
    fs: SyncFsFileIo,
    path: string,

    empty: boolean,
    maxFile?: number,
    size?: number,
    version?: string
  ) {
    this.fs = fs;
    this.where = path;
    this.maxFile = maxFile;
    const { pread, pwrite, truncate } = fs;
    if (size !== undefined && pread && pwrite && truncate) {
      const io = { pread: pread.bind(fs), pwrite: pwrite.bind(fs), truncate: truncate.bind(fs) };
      this.ranged = new RangedFile(io, path, size, version);
      if (empty) this.truncate(0);
    } else if (empty) {
      this.data = new Uint8Array(0);
      this.dirty = true;
      this.whole = true;
    }
  }

  get path(): string {
    return this.where;
  }

  set path(path: string) {
    this.where = path;
    if (this.ranged) this.ranged.path = path;
  }

  get isRanged(): boolean {
    return this.ranged !== undefined;
  }

  get pin(): string | undefined {
    return this.ranged?.pinnedVersion;
  }

  keep(): void {
    if (this.ranged) this.ranged.pin();
    else this.load();
  }

  load(): Uint8Array {
    if (!this.data) {
      this.data = this.fs.readFile(this.path);
      this.length = this.data.length;
    }
    return this.data;
  }

  size(): number {
    if (this.ranged) return this.ranged.size();
    this.load();
    return this.length;
  }

  pread(max: number, at: number): Uint8Array {
    if (this.ranged) return this.ranged.read(at, max);
    const bytes = this.load();
    const n = Math.max(0, Math.min(max, this.length - at));
    return bytes.subarray(at, at + n);
  }

  private fits(end: number): void {
    if (this.maxFile !== undefined && end > this.maxFile) throw new WasiError('EFBIG');
  }

  pwrite(bytes: Uint8Array, at: number): number {
    if (bytes.length === 0) return 0;
    const end = at + bytes.length;
    this.fits(end);
    this.dirty = true;
    if (this.ranged) {
      this.ranged.write(at, bytes);
      return bytes.length;
    }
    this.load();
    this.ensure(end);
    const buf = this.data as Uint8Array;
    this.from = Math.min(this.from, at, this.length);
    this.to = Math.max(this.to, end);
    if (at > this.length) buf.fill(0, this.length, at);
    buf.set(bytes, at);
    this.length = Math.max(this.length, end);
    return bytes.length;
  }

  truncate(size: number): void {
    this.fits(size);
    this.dirty = true;
    if (this.ranged) {
      this.ranged.truncate(size);
      return;
    }
    this.load();
    this.ensure(size);
    this.whole = true;
    if (size > this.length) (this.data as Uint8Array).fill(0, this.length, size);
    this.length = size;
  }

  private ensure(need: number): void {
    const cur = this.data as Uint8Array;
    if (cur.length >= need) return;
    const grown = new Uint8Array(Math.max(need, cur.length * 2, 4096));
    grown.set(cur.subarray(0, this.length));
    this.data = grown;
  }

  orphan(): void {
    this.orphaned = true;
    this.ranged?.pin();
  }

  isOrphan(): boolean {
    return this.orphaned;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  contents(): Uint8Array {
    if (this.ranged) return this.ranged.read(0, this.ranged.size());
    return this.load().slice(0, this.length);
  }

  flush(): void {
    if (this.orphaned || !this.dirty) return;
    if (this.ranged) this.ranged.flush();
    else if (!this.data) return;
    else if (this.whole || !this.fs.pwrite)
      this.fs.writeFile(this.path, this.data.slice(0, this.length), true);
    else this.fs.pwrite(this.path, this.from, this.data.slice(this.from, this.to), true);
    this.dirty = false;
    this.whole = false;
    this.from = Infinity;
    this.to = 0;
  }
}

export class LocalFile {
  offset = 0;
  refs = 1;

  readonly buffer: FileBuffer;
  readonly readable: boolean;
  readonly writable: boolean;
  append: boolean;
  constructor(buffer: FileBuffer, readable: boolean, writable: boolean, append: boolean) {
    this.buffer = buffer;
    this.readable = readable;
    this.writable = writable;
    this.append = append;
  }

  get path(): string {
    return this.buffer.path;
  }

  size(): number {
    return this.buffer.size();
  }

  pread(max: number, at: number): Uint8Array {
    return this.buffer.pread(max, at);
  }

  read(max: number): Uint8Array {
    const out = this.buffer.pread(max, this.offset);
    this.offset += out.length;
    return out;
  }

  pwrite(bytes: Uint8Array, at: number): number {
    return this.buffer.pwrite(bytes, at);
  }

  write(bytes: Uint8Array): number {
    if (this.append) this.offset = this.buffer.size();
    const n = this.buffer.pwrite(bytes, this.offset);
    this.offset += n;
    return n;
  }

  truncate(size: number): void {
    this.buffer.truncate(size);
  }

  flush(): void {
    this.buffer.flush();
  }
}

export interface DirListing {
  names: string[];
  stats: Map<string, SyncFsBridgeStat | null>;
}

export type WasiEntry =
  | {
      type: 'kernel';

      kind?: KernelFdKind;
      nonblock: boolean;
      append: boolean;
      path?: string;
      ino?: number;
    }
  | { type: 'file'; file: LocalFile }
  | {
      type: 'dir';
      path: string;

      preopen?: string;
      twin?: number;
      listing?: DirListing;
    }
  | {
      type: 'device';
      device: 'null' | 'zero' | 'full' | 'urandom';

      access?: DeviceAccess;
    };

export function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

const MAX_LINKS = 40;

export function physical(fs: Pick<SyncFsPosixBridge, 'lstat' | 'readlink'>, path: string): string {
  let done: string[] = [];
  let todo = path.split('/').filter((part) => part !== '' && part !== '.');
  let hops = 0;
  while (todo.length > 0) {
    const part = todo.shift() as string;
    if (part === '..') {
      done.pop();
      continue;
    }
    if (!todo.includes('..')) {
      done.push(part);
      continue;
    }
    const at = `/${[...done, part].join('/')}`;
    const st = fs.lstat(at);
    if (st.isSymbolicLink) {
      if (++hops > MAX_LINKS) throw new WasiError('ELOOP');
      const target = fs.readlink(at);
      if (target.startsWith('/')) done = [];
      todo = [...target.split('/').filter((p) => p !== '' && p !== '.'), ...todo];
    } else if (!st.isDirectory) {
      throw new WasiError('ENOTDIR');
    } else {
      done.push(part);
    }
  }
  return `/${done.join('/')}`;
}

export function resolveUnder(dir: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${dir}/${path}`);
}

export function pathInode(path: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < path.length; i++) {
    h ^= BigInt(path.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

export const MISS_TTL_MS = 20;

interface Miss {
  error: Error;
  until: number;
}

export const FS_GEN = 4;
const RING = 8;
const RING_SIZE = 64;
const SLOT = 3;
export const SHARED_IDS_BYTES = (RING + RING_SIZE * SLOT) * 4;

type Cached = SyncFsBridgeStat | Miss;

function inoKey(st: Cached): number {
  return 'ino' in st && typeof st.ino === 'number' ? (st.ino % 4294967296) | 0 : 0;
}

function pathHash(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return h === 0 ? 1 : h;
}

class StatCache {
  readonly stats = new Map<string, Cached>();
  readonly lstats = new Map<string, Cached>();
  private readonly byHash = new Map<number, Set<string>>();
  private readonly byIno = new Map<number, Set<string>>();
  private readonly shared: Int32Array | undefined;
  private seen: number;
  constructor(shared: Int32Array | undefined) {
    this.shared = shared;
    this.seen = shared ? Atomics.load(shared, FS_GEN) : 0;
  }

  put(map: Map<string, Cached>, path: string, entry: Cached): void {
    map.set(path, entry);
    if (!this.shared) return;
    index(this.byHash, pathHash(path), path);
    const ino = inoKey(entry);
    if (ino !== 0) index(this.byIno, ino, path);
  }

  fresh(): void {
    if (!this.shared) return;
    const now = Atomics.load(this.shared, FS_GEN);
    if (now === this.seen) return;
    this.replay(now);
    this.seen = now;
  }

  changed(path: string | undefined, ino = 0): void {
    const key = (ino % 4294967296) | 0;
    if (this.shared) {
      const g = this.publish(this.shared, path === undefined ? 0 : pathHash(path), key);
      this.replay(g - 1);
      this.seen = g;
      if (path === undefined) this.clear();
      else this.drop(pathHash(path), key);
    }
    if (path === undefined) return;
    this.stats.delete(path);
    this.lstats.delete(path);
  }

  mutated(paths: readonly string[], ...inos: number[]): void {
    this.clear();
    if (!this.shared) return;
    for (const [i, hash] of (paths.length > 0 ? paths.map(pathHash) : [0]).entries()) {
      this.seen = this.publish(this.shared, hash, ((inos[i] ?? 0) % 4294967296) | 0);
    }
  }

  inoOf(path: string, look: () => SyncFsBridgeStat, map = this.stats): number {
    if (!this.shared) return 0;
    this.fresh();
    const hit = map.get(path);
    if (hit && 'ino' in hit && typeof hit.ino === 'number') return hit.ino;
    try {
      return look().ino ?? 0;
    } catch {
      return 0;
    }
  }

  private publish(shared: Int32Array, hash: number, ino: number): number {
    const g = Atomics.add(shared, FS_GEN, 1) + 1;
    const at = RING + (g % RING_SIZE) * SLOT;
    Atomics.store(shared, at, 0);
    Atomics.store(shared, at + 1, hash);
    Atomics.store(shared, at + 2, ino);
    Atomics.store(shared, at, g);
    return g;
  }

  private replay(upTo: number): void {
    const shared = this.shared as Int32Array;
    const missed: Array<[number, number]> = [];
    for (let g = this.seen + 1; g <= upTo && upTo - this.seen <= RING_SIZE; g++) {
      const at = RING + (g % RING_SIZE) * SLOT;
      const tag = Atomics.load(shared, at);
      const hash = Atomics.load(shared, at + 1);
      const ino = Atomics.load(shared, at + 2);
      if (tag !== g || hash === 0 || Atomics.load(shared, at) !== g) break;
      missed.push([hash, ino]);
    }
    if (missed.length < upTo - this.seen) this.clear();
    else for (const [hash, ino] of missed) this.drop(hash, ino);
  }

  private drop(hash: number, ino: number): void {
    const paths = [
      ...(this.byHash.get(hash) ?? []),
      ...(ino === 0 ? [] : (this.byIno.get(ino) ?? [])),
    ];
    for (const path of paths) {
      this.stats.delete(path);
      this.lstats.delete(path);
    }
    this.byHash.delete(hash);
    if (ino !== 0) this.byIno.delete(ino);
  }

  private clear(): void {
    this.stats.clear();
    this.lstats.clear();
    this.byHash.clear();
    this.byIno.clear();
  }
}

function index(map: Map<number, Set<string>>, key: number, path: string): void {
  const paths = map.get(key) ?? new Set<string>();
  paths.add(path);
  map.set(key, paths);
}

export function cachingBridge(
  bridge: SyncFsPosixBridge,
  now: () => number = () => performance.now(),
  shared?: Int32Array
): SyncFsPosixBridge & { invalidate(): void; touched(path?: string, ino?: number): void } {
  const blind = shared !== undefined && shared.length * 4 < SHARED_IDS_BYTES;
  const cache = new StatCache(blind ? undefined : shared);
  const { stats, lstats } = cache;
  const cached = (map: typeof stats, path: string, get: () => SyncFsBridgeStat) => {
    if (blind) return get();
    cache.fresh();
    let hit = map.get(path);
    if (hit === undefined || ('until' in hit && hit.until <= now())) {
      try {
        hit = get();
      } catch (e) {
        hit = { error: e as Error, until: now() + MISS_TTL_MS };
      }
      cache.put(map, path, hit);
    }
    if ('until' in hit) throw hit.error;
    return hit;
  };
  const invalidate = () => cache.mutated([]);
  const touched = (path?: string, ino?: number) => cache.changed(path, ino);

  const mutating = <T>(op: () => T, ...paths: string[]): T => removing(op, paths, []);
  const removing = <T>(op: () => T, paths: string[], inos: number[]): T => {
    try {
      return op();
    } finally {
      cache.mutated(paths, ...inos);
    }
  };
  const linkIno = (p: string, known?: SyncFsBridgeStat) =>
    cache.inoOf(p, () => known ?? bridge.lstat(p), lstats);
  const rewriting = <T>(p: string, op: () => T, ...also: string[]): T => {
    const ino = cache.inoOf(p, () => bridge.stat(p));
    try {
      return op();
    } finally {
      cache.mutated([p, ...also], ino);
    }
  };
  const entry = (p: string) => [p, p.slice(0, p.lastIndexOf('/')) || '/'];
  const fileAt = (p: string) => {
    try {
      const st = bridge.lstat(p);
      return st.isDirectory ? undefined : st;
    } catch {
      return undefined;
    }
  };
  return {
    readFile: (p) => bridge.readFile(p),
    readdir: (p) => bridge.readdir(p),

    readdirStat: (p: string) => {
      const list = bridge.readdirStat(p);
      const base = p === '/' ? '' : p;
      for (const [name, st] of list) {
        if (!st || blind) continue;
        cache.put(lstats, `${base}/${name}`, st);
        if (!st.isSymbolicLink) cache.put(stats, `${base}/${name}`, st);
      }
      return list;
    },
    readlink: (p) => bridge.readlink(p),
    stat: (p) => cached(stats, p, () => bridge.stat(p)),
    lstat: (p) => cached(lstats, p, () => bridge.lstat(p)),
    exists: (p) => {
      try {
        cached(stats, p, () => bridge.stat(p));
        return true;
      } catch {
        return false;
      }
    },
    writeFile: (p, bytes, open) =>
      rewriting(p, () => bridge.writeFile(p, bytes, open), ...entry(p).slice(1)),
    mkdir: (p) => mutating(() => bridge.mkdir(p), ...entry(p)),
    rm: (p) => {
      const st = fileAt(p);
      if (!st) return mutating(() => bridge.rm(p));
      return removing(() => bridge.rm(p), entry(p), [linkIno(p, st)]);
    },
    rename: (from, to) => {
      const st = fileAt(from);
      if (!st) return mutating(() => bridge.rename(from, to));
      const inos = [linkIno(from, st), 0, linkIno(to), 0];
      return removing(() => bridge.rename(from, to), [...entry(from), ...entry(to)], inos);
    },
    unlink: (p) => removing(() => bridge.unlink(p), entry(p), [linkIno(p)]),
    rmdir: (p) => mutating(() => bridge.rmdir(p), ...entry(p)),
    symlink: (target, link) => mutating(() => bridge.symlink(target, link), ...entry(link)),
    chmod: (p, mode) => rewriting(p, () => bridge.chmod(p, mode)),
    utimes: (p, a, m) => rewriting(p, () => bridge.utimes(p, a, m)),
    lutimes: (p, a, m) => mutating(() => bridge.lutimes(p, a, m), p),
    ...(bridge.hold ? { hold: bridge.hold.bind(bridge) } : {}),
    ...(bridge.kept ? { kept: bridge.kept.bind(bridge) } : {}),
    ...(bridge.pinned ? { pinned: (handle: number) => pinnedIo(bridge, handle, rewriting) } : {}),
    ...(bridge.create
      ? { create: (p: string) => mutating(() => bridge.create?.(p), ...entry(p)) }
      : {}),
    ...(bridge.pread && bridge.pwrite && bridge.truncate
      ? {
          pread: bridge.pread.bind(bridge),
          pwrite: (p: string, at: number, bytes: Uint8Array, transfer?: boolean) =>
            rewriting(p, () => bridge.pwrite?.(p, at, bytes, transfer)),
          truncate: (p: string, size: number) => rewriting(p, () => bridge.truncate?.(p, size)),
        }
      : {}),
    invalidate,
    touched,
  };
}

function pinnedIo(
  bridge: SyncFsPosixBridge,
  handle: number,
  rewriting: <T>(p: string, op: () => T) => T
): SyncFsFileIo {
  const io = (bridge.pinned as NonNullable<SyncFsPosixBridge['pinned']>)(handle);
  const { pread, pwrite, truncate } = io as Required<SyncFsFileIo>;
  return {
    readFile: (p) => io.readFile(p),
    writeFile: (p, bytes, open) => rewriting(p, () => io.writeFile(p, bytes, open)),
    pread: (p, at, n, version) => pread(p, at, n, version),
    pwrite: (p, at, bytes, transfer) => rewriting(p, () => pwrite(p, at, bytes, transfer)),
    truncate: (p, size) => rewriting(p, () => truncate(p, size)),
  };
}
