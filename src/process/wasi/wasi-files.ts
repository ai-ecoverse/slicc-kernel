import { RangedFile } from '../../fs/ranged.ts';
import type { DeviceAccess, KernelFdKind } from '../../kernel/fd-table.ts';
import type { SyncFsBridgeStat, SyncFsPosixBridge } from '../../realm/sync-fs-wire.ts';

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

  private readonly fs: SyncFsPosixBridge;
  private where: string;
  private readonly ranged: RangedFile | undefined;

  maxFile: number | undefined;
  constructor(
    fs: SyncFsPosixBridge,
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
      this.fs.writeFile(this.path, this.data.slice(0, this.length));
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

export function cachingBridge(
  bridge: SyncFsPosixBridge,
  now: () => number = () => performance.now()
): SyncFsPosixBridge & { invalidate(): void } {
  const stats = new Map<string, SyncFsBridgeStat | Miss>();
  const lstats = new Map<string, SyncFsBridgeStat | Miss>();
  const cached = (map: typeof stats, path: string, get: () => SyncFsBridgeStat) => {
    let hit = map.get(path);
    if (hit === undefined || ('until' in hit && hit.until <= now())) {
      try {
        hit = get();
      } catch (e) {
        hit = { error: e as Error, until: now() + MISS_TTL_MS };
      }
      map.set(path, hit);
    }
    if ('until' in hit) throw hit.error;
    return hit;
  };
  const invalidate = () => {
    stats.clear();
    lstats.clear();
  };

  const mutating = <T>(op: () => T): T => {
    try {
      return op();
    } finally {
      invalidate();
    }
  };
  return {
    readFile: (p) => bridge.readFile(p),
    readdir: (p) => bridge.readdir(p),

    readdirStat: (p: string) => {
      const list = bridge.readdirStat(p);
      const base = p === '/' ? '' : p;
      for (const [name, st] of list) {
        if (!st) continue;
        lstats.set(`${base}/${name}`, st);
        if (!st.isSymbolicLink) stats.set(`${base}/${name}`, st);
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
    writeFile: (p, bytes) => mutating(() => bridge.writeFile(p, bytes)),
    mkdir: (p) => mutating(() => bridge.mkdir(p)),
    rm: (p) => mutating(() => bridge.rm(p)),
    rename: (from, to) => mutating(() => bridge.rename(from, to)),
    unlink: (p) => mutating(() => bridge.unlink(p)),
    rmdir: (p) => mutating(() => bridge.rmdir(p)),
    symlink: (target, link) => mutating(() => bridge.symlink(target, link)),
    chmod: (p, mode) => mutating(() => bridge.chmod(p, mode)),
    utimes: (p, a, m) => mutating(() => bridge.utimes(p, a, m)),
    lutimes: (p, a, m) => mutating(() => bridge.lutimes(p, a, m)),
    ...(bridge.pread && bridge.pwrite && bridge.truncate
      ? {
          pread: bridge.pread.bind(bridge),
          pwrite: (p: string, at: number, bytes: Uint8Array, transfer?: boolean) =>
            mutating(() => bridge.pwrite?.(p, at, bytes, transfer)),
          truncate: (p: string, size: number) => mutating(() => bridge.truncate?.(p, size)),
        }
      : {}),
    invalidate,
  };
}
