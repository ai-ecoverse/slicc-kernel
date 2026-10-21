import { linkedWatch } from '../../fs/ranged.ts';
import {
  type DeviceAccess,
  type DeviceMeta,
  deviceAt,
  type HeldMeta,
  type KernelFdKind,
} from '../../kernel/fd-table.ts';
import type { HeldCwd, HeldCwdReply } from '../../kernel/held-cwd.ts';
import type { FdInfo, WasmSyscall } from '../../kernel/process.ts';
import {
  HOLD_CREATED,
  HOLD_READ,
  HOLD_WRITE,
  type SyncFsBridgeStat,
  type SyncFsPosixBridge,
} from '../../realm/sync-fs-wire.ts';
import type { ProcessSys } from '../kernel-streams.ts';
import { FDFLAGS, OFLAGS, RIGHTS } from './wasi-abi.ts';
import {
  FD_RING,
  FD_RING_SIZE,
  FileBuffer,
  LocalFile,
  normalize,
  physical,
  realOf,
  type WasiEntry,
  WasiError,
} from './wasi-files.ts';

const SYNTHETIC_DIRS = ['usr', 'bin'];

export interface WasiKernel {
  sys: ProcessSys;

  call(req: WasmSyscall): unknown;
}

type Device = 'null' | 'zero' | 'full' | 'urandom';

const O_NONBLOCK = 0o4000;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;

export type WasiForkFd =
  | { fd: number; type: 'kernel'; nonblock: boolean; append: boolean }
  | { fd: number; type: 'dir'; path: string; preopen?: string; twin?: number }
  | { fd: number; type: 'device'; device: Device; access?: DeviceAccess };

function stdioAlias(path: string): number | undefined {
  const m = /^\/dev\/(?:(stdin)|(stdout)|(stderr)|fd\/(\d+))$/.exec(path);
  if (!m) return undefined;
  return m[1] ? 0 : m[2] ? 1 : m[3] ? 2 : Number(m[4]);
}

export const SEALED_PATH = '/dev/sealed';
export const CLIPBOARD_PATH = '/dev/clipboard';

export function deviceOf(path: string): Device | undefined {
  return deviceAt(path);
}

function namedDevice(path: string): boolean {
  if (deviceOf(path) || stdioAlias(path) !== undefined) return true;
  return path === SEALED_PATH || path === CLIPBOARD_PATH || path === '/dev/tty';
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}

export class WasiFds {
  private readonly table = new Map<number, WasiEntry>();

  private readonly buffers = new Map<string, FileBuffer>();

  private readonly reported = new WeakSet<FileBuffer>();

  private readonly byId = new Map<string, FileBuffer>();

  private readonly ids = new Map<FileBuffer, string>();

  private readonly kernel: WasiKernel;
  private readonly fs: SyncFsPosixBridge;
  private renamesSeen: number;
  constructor(kernel: WasiKernel, fs: SyncFsPosixBridge) {
    this.kernel = kernel;
    this.fs = fs;
    this.renamesSeen = fs.changes?.renames() ?? 0;
  }

  ownRename(): void {
    const now = this.fs.changes?.renames() ?? 0;
    if (now === ((this.renamesSeen + 1) | 0)) this.renamesSeen = now;
  }

  followRenames(): boolean {
    const now = this.fs.changes?.renames() ?? 0;
    if (now === this.renamesSeen || !this.fs.renames) return false;
    const held = [...this.buffers].filter(([, b]) => !b.isOrphan()).map(([p]) => p);
    if (held.length === 0) {
      this.renamesSeen = now;
      return false;
    }
    const { now: seen, renames } = this.fs.renames(this.renamesSeen, held);
    this.renamesSeen = seen;
    for (const [from, to] of renames) this.renamed(from, to, undefined, true);
    return renames.length > 0;
  }

  setup(
    cwd: string,
    inherited: ReadonlyArray<{
      fd: number;
      kind?: KernelFdKind;
      flags?: number;
      device?: DeviceMeta;
    }>,
    root = false
  ): void {
    for (const fd of [0, 1, 2]) this.table.set(fd, this.stdioEntry(fd));
    const preopens = this.preopens(cwd, root);
    const top = 3 + preopens.length;
    for (const { fd, kind, flags, device } of inherited) {
      let at = fd;
      if (fd < top) {
        at = this.kernel.call({ op: 'fd-dup', fd, min: top }) as number;
        this.kernel.sys.close(fd);
      }
      if (device) {
        this.table.set(at, deviceEntry(device));
        continue;
      }

      const nonblock = ((flags ?? 0) & O_NONBLOCK) !== 0;
      this.table.set(at, { ...kernelEntry(), nonblock, ...(kind ? { kind } : {}) });
    }
    preopens.forEach((entry, i) => {
      this.kernel.call({ op: 'fd-reserve', fd: 3 + i, meta: metaOf(entry) as HeldMeta });
      this.table.set(3 + i, entry);
    });
  }

  adoptCopy(fd: number): number {
    const at = this.kernel.call({ op: 'fd-dup', fd, min: 3 }) as number;
    this.table.set(at, this.stdioEntry(at));
    return at;
  }

  preopenAt(path: string, name: string): number {
    return this.install({ type: 'dir', path: normalize(path), preopen: name });
  }

  private preopens(cwd: string, root: boolean): WasiEntry[] {
    const here = normalize(cwd);
    const dot: Extract<WasiEntry, { type: 'dir' }> = { type: 'dir', path: here, preopen: '.' };
    const out: WasiEntry[] = [dot];
    let names: string[] = [];
    try {
      names = this.fs.readdir('/');
    } catch {
      return out;
    }

    for (const name of [...new Set([...names, 'dev', ...SYNTHETIC_DIRS])].sort()) {
      const path = `/${name}`;
      if (path === '/dev') {
        out.push({ type: 'dir', path, preopen: path });
        continue;
      }
      try {
        if (this.fs.stat(path).isDirectory) out.push({ type: 'dir', path, preopen: path });
      } catch {}
    }
    if (root) {
      out.push(
        { type: 'dir', path: '/', preopen: '/' },
        { type: 'dir', path: here, preopen: './' }
      );
      dot.twin = 3 + out.length - 1;
    }
    return out;
  }

  find(fd: number): WasiEntry | undefined {
    if (!this.shared) return this.table.get(fd);
    this.sync();
    return this.table.get(fd) ?? this.fetch(fd);
  }

  private shared: Int32Array | undefined;
  private seen = 0;

  get isShared(): boolean {
    return this.shared !== undefined;
  }

  share(ids: Int32Array, fresh: boolean): void {
    if (!fresh) {
      this.promoteFiles();
      for (const fd of this.cloexec) this.kernel.call({ op: 'fd-cloexec', fd, on: true });
      for (const [fd, e] of this.table) {
        if (e.type === 'kernel' && (e.nonblock || e.append)) this.publishFlags(fd, e);
      }
    } else {
      this.table.clear();
      this.cloexec.clear();
    }
    this.shared = ids;
    (this.fs as { threaded?(): void }).threaded?.();
    this.seen = Atomics.load(ids, GEN);
  }

  private sync(): void {
    const shared = this.shared as Int32Array;
    const gen = Atomics.load(shared, GEN);
    if (gen === this.seen) return;
    if (!this.replay(shared, gen)) {
      this.table.clear();
      this.cloexec.clear();
    }
    this.seen = gen;
  }

  private replay(shared: Int32Array, upTo: number): boolean {
    if (upTo - this.seen > FD_RING_SIZE || !ringed(shared)) return false;
    const changed: number[] = [];
    for (let g = this.seen + 1; g <= upTo; g++) {
      const at = FD_RING + (g % FD_RING_SIZE) * 2;
      if (Atomics.load(shared, at) !== g) return false;
      const fd = Atomics.load(shared, at + 1);
      if (fd < 0 || Atomics.load(shared, at) !== g) return false;
      changed.push(fd);
    }
    for (const fd of changed) {
      this.table.delete(fd);
      this.cloexec.delete(fd);
    }
    return true;
  }

  private bump(...fds: number[]): void {
    if (!this.shared) return;
    const shared = this.shared;
    for (const fd of fds.length > 0 ? fds : [-1]) {
      const gen = Atomics.add(shared, GEN, 1) + 1;
      if (ringed(shared)) {
        const at = FD_RING + (gen % FD_RING_SIZE) * 2;
        Atomics.store(shared, at, 0);
        Atomics.store(shared, at + 1, fd);
        Atomics.store(shared, at, gen);
      }
      if (gen - 1 === this.seen) this.seen = gen;
    }
  }

  private stdioEntry(fd: number): WasiEntry {
    let info: FdInfo;
    try {
      info = this.kernel.call({ op: 'fd-info', fd }) as FdInfo;
    } catch {
      return kernelEntry();
    }
    return info?.meta && 'dir' in info.meta ? { type: 'dir', path: info.meta.dir } : kernelEntry();
  }

  private fetch(fd: number): WasiEntry | undefined {
    let info: FdInfo;
    try {
      info = this.kernel.call({ op: 'fd-info', fd }) as FdInfo;
    } catch {
      return undefined;
    }
    const e = entryOf(info);
    if (!e) return undefined;
    this.table.set(fd, e);
    if (info.cloexec) this.cloexec.add(fd);
    return e;
  }

  private listed(): Array<[number, WasiEntry, boolean]> {
    const out: Array<[number, WasiEntry, boolean]> = [];
    for (const info of this.kernel.call({ op: 'fd-list' }) as Array<FdInfo & { fd: number }>) {
      const e = entryOf(info);
      if (e) out.push([info.fd, e, info.cloexec === true]);
    }
    return out;
  }

  private publishFlags(fd: number, e: { nonblock: boolean; append: boolean }): void {
    const flags = (e.nonblock ? O_NONBLOCK : 0) | (e.append ? O_APPEND : 0);
    this.kernel.call({ op: 'fd-setfl', fd, flags });
  }

  setFlags(fd: number, nonblock: boolean, append: boolean): void {
    const e = this.get(fd);
    if (e.type === 'kernel') {
      e.nonblock = nonblock;
      e.append = append;
      if (this.shared) {
        this.publishFlags(fd, e);
        this.bump(fd);
      }
    } else if (e.type === 'file') e.file.append = append;
  }

  setCloexec(fd: number, on: boolean): void {
    this.get(fd);
    if (on) this.cloexec.add(fd);
    else this.cloexec.delete(fd);
    if (this.shared) {
      this.kernel.call({ op: 'fd-cloexec', fd, on });
      this.bump(fd);
    }
  }

  cwd(): string | undefined {
    const dot = this.find(3);
    return dot?.type === 'dir' && dot.preopen === '.' ? dot.path : undefined;
  }

  terminals(): number[] {
    const fds = this.shared
      ? (this.kernel.call({ op: 'fd-list' }) as Array<FdInfo & { fd: number }>)
          .filter((info) => info.tty)
          .map((info) => info.fd)
      : [...this.table]
          .filter(([, e]) => e.type === 'kernel' && e.kind === 'tty')
          .map(([fd]) => fd);
    return fds.sort((a, b) => a - b);
  }

  sockets(): number[] {
    return [...this.table]
      .filter(([, e]) => e.type === 'kernel' && e.kind === 'socket')
      .map(([fd]) => fd)
      .sort((a, b) => a - b);
  }

  adopt(fd: number, kind: KernelFdKind, nonblock: boolean, dgram = false): void {
    this.table.set(fd, { type: 'kernel', kind, dgram, nonblock, append: false });
    if (this.shared && nonblock) this.publishFlags(fd, { nonblock, append: false });
    this.bump(fd);
  }

  get(fd: number): WasiEntry {
    const e = this.find(fd);
    if (!e) throw new WasiError('EBADF');
    if (e.type === 'file') this.followRenames();
    return e;
  }

  preopen(fd: number): Extract<WasiEntry, { type: 'dir' }> & { preopen: string } {
    const e = this.find(fd);
    if (e?.type !== 'dir' || e.preopen === undefined) throw new WasiError('EBADF');
    return e as Extract<WasiEntry, { type: 'dir' }> & { preopen: string };
  }

  dir(fd: number): Extract<WasiEntry, { type: 'dir' }> {
    const e = this.get(fd);
    if (e.type !== 'dir') throw new WasiError('ENOTDIR');
    return e;
  }

  private install(e: WasiEntry, min = 3): number {
    const meta = metaOf(e);
    const fd = this.kernel.call({
      op: 'fd-reserve',
      ...(min > 3 ? { min } : {}),
      ...(meta ? { meta } : {}),
    }) as number;
    this.table.set(fd, e);
    this.bump(fd);
    return fd;
  }

  readonly cloexec = new Set<number>();

  implicitCloexec = false;

  dup(fd: number, min: number, cloexec: boolean): number {
    const e = this.get(fd);
    let at: number;
    if (e.type !== 'file') {
      at = this.kernel.call({ op: 'fd-dup', fd, min: Math.max(3, min) }) as number;
      this.table.set(at, { ...e });
    } else {
      e.file.refs++;
      at = this.install(e, min);
    }
    if (cloexec) this.setCloexec(at, true);
    this.bump(at);
    return at;
  }

  pipe(): [number, number] {
    const [r, w] = this.kernel.sys.pipe();
    this.table.set(r, { type: 'kernel', kind: 'stream', nonblock: false, append: false });
    this.table.set(w, { type: 'kernel', kind: 'stream', nonblock: false, append: false });
    this.bump(r, w);
    return [r, w];
  }

  chdir(path: string): void {
    const dot = this.find(3);
    if (dot?.type !== 'dir' || dot.preopen !== '.') return;
    const moved: Array<[number, Extract<WasiEntry, { type: 'dir' }>]> = [[3, dot]];
    const twin = dot.twin === undefined ? undefined : this.find(dot.twin);
    if (twin?.type === 'dir' && twin.preopen === './') moved.push([dot.twin as number, twin]);
    for (const [fd, e] of moved) {
      e.path = path;
      this.kernel.call({ op: 'fd-meta', fd, meta: metaOf(e) as HeldMeta });
    }
    this.held?.moved(this.kernel.call({ op: 'cwd-chdir', path }) as HeldCwdReply, path);
    this.bump();
  }

  promote(fd: number, moved = false): void {
    const e = this.get(fd);
    if (e.type === 'file' && (!moved || this.moved(fd))) this.promoteFiles(e.file.buffer);
  }

  promoteFiles(only?: FileBuffer): void {
    const promoted = new Map<LocalFile, number>();

    const handed = new Set<FileBuffer>();
    for (const [fd, e] of [...this.table]) {
      if (e.type !== 'file' || (only && e.file.buffer !== only)) continue;
      const first = promoted.get(e.file);
      if (first !== undefined) {
        this.kernel.call({ op: 'fd-promote', fd, share: first });
      } else {
        this.kernel.call(promoteRequest(fd, e.file, handed));
        handed.add(e.file.buffer);
        promoted.set(e.file, fd);
      }
      this.table.set(fd, {
        type: 'kernel',
        kind: 'file',
        nonblock: false,
        append: e.file.append,
        path: e.file.path,
        ino: this.inoOf(e.file.path),
      });
    }
    for (const file of promoted.keys()) {
      if (--file.buffer.opens <= 0) {
        this.forget(file.buffer);
        this.letGo(file.buffer);
      }
    }
  }

  snapshot(): WasiForkFd[] {
    const out: WasiForkFd[] = [];

    if (this.shared) return out;
    for (const [fd, e] of this.table) {
      if (e.type === 'kernel')
        out.push({ fd, type: 'kernel', nonblock: e.nonblock, append: e.append });
      else if (e.type === 'dir') out.push({ fd, type: 'dir', path: e.path, ...preopenOf(e) });
      else if (e.type === 'device') out.push({ fd, ...deviceEntry(e) });
    }
    return out;
  }

  restore(fds: readonly WasiForkFd[], cloexec: readonly number[]): void {
    this.table.clear();
    for (const f of fds) {
      if (f.type === 'kernel')
        this.table.set(f.fd, { type: 'kernel', nonblock: f.nonblock, append: f.append });
      else if (f.type === 'dir')
        this.table.set(f.fd, { type: 'dir', path: f.path, ...preopenOf(f) });
      else this.table.set(f.fd, deviceEntry(f));
    }
    for (const fd of cloexec) this.cloexec.add(fd);
  }

  inheritable(): Map<number, number> {
    const out = new Map<number, number>();
    const all = this.shared
      ? this.listed()
      : [...this.table].map(([fd, e]): [number, WasiEntry, boolean] => [
          fd,
          e,
          this.cloexec.has(fd),
        ]);
    for (const [fd, e, cloexec] of all) {
      if (e.type !== 'kernel' || cloexec) continue;
      if (this.implicitCloexec && fd > 2) continue;
      out.set(fd, fd);
    }
    return out;
  }

  private locking = false;

  holdLocks(): void {
    this.locking = true;
  }

  private dropLocks(e: WasiEntry | undefined): void {
    if (!this.locking || e?.type !== 'file') return;
    try {
      this.kernel.call({ op: 'lk-close', path: e.file.path });
    } catch {}
  }

  close(fd: number): void {
    const e = this.get(fd);
    this.table.delete(fd);
    this.cloexec.delete(fd);
    try {
      this.kernel.sys.close(fd);
    } finally {
      this.release(e);
      this.dropLocks(e);
      this.bump(fd);
    }
  }

  renumber(from: number, to: number, keep = false): void {
    const e = this.get(from);

    const old = keep ? this.find(to) : this.get(to);
    if (from === to) return;
    this.kernel.call({ op: 'fd-renumber', from, to, ...(keep ? { keep } : {}) });
    this.cloexec.delete(to);
    if (keep) {
      if (e.type === 'file') e.file.refs++;
      this.table.set(to, e.type === 'file' ? e : { ...e });
    } else {
      this.table.delete(from);
      this.table.set(to, e);
      if (this.cloexec.delete(from)) this.cloexec.add(to);
    }
    if (old) this.release(old);
    this.dropLocks(old);
    this.bump(from, to);
  }

  private release(e: WasiEntry): void {
    if (e.type !== 'file' || --e.file.refs > 0) return;
    const { buffer } = e.file;
    try {
      buffer.flush();
      this.reported.delete(buffer);
    } catch (err) {
      this.reported.add(buffer);
      this.drop(buffer);
      throw err;
    }
    this.drop(buffer);
  }

  private drop(buffer: FileBuffer): void {
    if (--buffer.opens > 0) return;
    this.forget(buffer);
    this.letGo(buffer);
  }

  private forget(buffer: FileBuffer): void {
    for (const [p, b] of [...this.buffers]) if (b === buffer) this.buffers.delete(p);
    const id = this.ids.get(buffer);
    if (id !== undefined && this.byId.get(id) === buffer) this.byId.delete(id);
    this.ids.delete(buffer);
  }

  private know(buffer: FileBuffer, id: string): void {
    if (this.ids.has(buffer)) return;
    this.ids.set(buffer, id);
    if (!this.byId.has(id)) this.byId.set(id, buffer);
  }

  private identity(st: SyncFsBridgeStat | undefined): string | undefined {
    if (!st || st.ino === undefined || (st.nlink ?? 1) < 2) return undefined;
    return `${st.dev ?? 0}:${st.ino}`;
  }

  private sharing(path: string, st: SyncFsBridgeStat | undefined): FileBuffer | undefined {
    if (st?.ino === undefined) return undefined;
    const id = `${st.dev ?? 0}:${st.ino}`;
    if (!this.byId.has(id) && this.identity(st) !== undefined) this.learn();
    const buffer = this.byId.get(id);
    if (!buffer) return undefined;
    this.buffers.set(path, buffer);
    return buffer;
  }

  private learn(): void {
    for (const [p, buffer] of this.buffers) {
      if (this.ids.has(buffer) || buffer.isOrphan()) continue;
      const known = this.identity(this.statOrMissing(p));
      if (known !== undefined) this.know(buffer, known);
    }
  }

  linked(from: string, to: string): void {
    const buffer = this.buffers.get(from);
    if (!buffer || buffer.isOrphan()) return;
    const id = this.identity(this.statOrMissing(to));
    if (id === undefined) return;
    this.know(buffer, id);
    if (!this.buffers.has(to)) this.buffers.set(to, buffer);
  }

  private letGo(buffer: FileBuffer): void {
    this.fs.hold?.(buffer.path, false, true, buffer.handle);
  }

  kind(fd: number, e: Extract<WasiEntry, { type: 'kernel' }>): KernelFdKind {
    if (!e.kind) {
      const info = this.kernel.call({ op: 'fd-info', fd }) as {
        tty?: boolean;
        kind?: KernelFdKind;
        dgram?: true;
      };
      e.kind = info.kind ?? (info.tty ? 'tty' : 'stream');
      e.dgram = info.dgram === true;
    }
    return e.kind;
  }

  datagram(fd: number, e: Extract<WasiEntry, { type: 'kernel' }>): boolean {
    if (this.kind(fd, e) !== 'socket') return false;
    if (e.dgram === undefined) {
      e.dgram = (this.kernel.call({ op: 'fd-info', fd }) as { dgram?: true }).dgram === true;
    }
    return e.dgram;
  }

  flushAll(): void {
    for (const buffer of this.buffers.values()) {
      try {
        buffer.flush();
        this.reported.delete(buffer);
      } catch (err) {
        if (!this.reported.has(buffer)) throw err;
      }
    }
  }

  flushEarly(): void {
    for (const buffer of this.buffers.values()) {
      try {
        buffer.flush();
      } catch {}
    }
  }

  reread(fd: number): void {
    const e = this.get(fd);
    if (e.type === 'file') e.file.buffer.reread();
  }

  flushPath(path: string): void {
    for (const [p, buffer] of this.buffers) if (within(p, path)) buffer.flush();

    if (this.shared && !this.fs.changes?.clean()) this.kernel.call({ op: 'fd-path-flush', path });
  }

  holdsUnder(path: string): boolean {
    for (const p of this.buffers.keys()) if (within(p, path)) return true;
    return false;
  }

  unlinking(path: string, linked?: SyncFsBridgeStat): void {
    const buffer = this.buffers.get(path);
    if (buffer && this.survives(buffer, linked)) buffer.flush();
    else buffer?.keep();
    if (this.shared) this.kernel.call({ op: 'fd-path-unlinking', path });
  }

  unlinked(path: string, linked?: SyncFsBridgeStat): void {
    if (this.shared) this.kernel.call({ op: 'fd-path-unlinked', path });
    const buffer = this.buffers.get(path);
    if (!buffer) return;
    this.detach(buffer, linked);
    this.buffers.delete(path);
  }

  private openedIno(fd: number): number | undefined {
    try {
      return (this.kernel.call({ op: 'fd-vfs-stat', fd, identity: true }) as { ino?: number }).ino;
    } catch (err) {
      this.kernel.sys.close(fd);
      throw err;
    }
  }

  moved(fd: number): boolean {
    const e = this.get(fd);
    if (e.type !== 'file') return false;
    if (e.file.buffer.isOrphan()) return true;
    return e.file.ino !== undefined && this.inoOf(e.file.path) !== e.file.ino;
  }

  private inoOf(path: string): number | undefined {
    try {
      return this.fs.stat(path).ino;
    } catch {
      return undefined;
    }
  }

  private survives(buffer: FileBuffer, linked: SyncFsBridgeStat | undefined): boolean {
    return linked !== undefined && buffer.handle !== undefined;
  }

  private detach(buffer: FileBuffer, linked: SyncFsBridgeStat | undefined): void {
    if (this.survives(buffer, linked)) {
      const id = this.identity(linked);
      if (id !== undefined) this.know(buffer, id);
      return;
    }
    buffer.orphan();
    this.forget(buffer);
  }

  renamed(from: string, to: string, replacedLinked?: SyncFsBridgeStat, foreign = false): void {
    if (from === to) return;
    if (this.shared && !foreign) this.kernel.call({ op: 'fd-path-renamed', from, to });
    for (const e of this.table.values()) {
      if (e.type === 'kernel' && e.path !== undefined && within(e.path, from)) {
        e.path = to + e.path.slice(from.length);
      }
    }
    const moved: Array<[string, FileBuffer]> = [];
    for (const [p, buffer] of this.buffers) {
      if (foreign && buffer.isOrphan()) continue;
      if (within(p, from)) moved.push([p, buffer]);
      else if (within(p, to)) {
        this.detach(buffer, replacedLinked);
        this.buffers.delete(p);
      }
    }
    for (const [p] of moved) this.buffers.delete(p);
    for (const [p, buffer] of moved) {
      const next = to + p.slice(from.length);
      if (buffer.path === p) buffer.path = next;
      this.buffers.set(next, buffer);
    }
  }

  held: HeldCwd | undefined;

  private cwdEntry(dir: Extract<WasiEntry, { type: 'dir' }>): boolean {
    return dir.preopen === '.' || dir.preopen === './';
  }

  goneCwd(dir: Extract<WasiEntry, { type: 'dir' }>): boolean {
    return this.held !== undefined && this.cwdEntry(dir) && !this.held.alive(dir.path);
  }

  resolve(dirfd: number, path: string): string {
    if (path === '') throw new WasiError('ENOENT');
    if (path.startsWith('/')) return this.joined(path);
    const dir = this.dir(dirfd);
    if (path.split('/')[0] !== '..' && this.goneCwd(dir)) throw new WasiError('ENOENT');
    return this.joined(`${dir.path}/${path}`);
  }

  private joined(joined: string): string {
    return joined.split('/').includes('..') ? physical(this.fs, joined) : normalize(joined);
  }

  private openKernelDevice(
    path: string,
    oflags: number,
    fdflags: number,
    rights: bigint
  ): number | undefined {
    const { openSealed, openClipboard, openTty } = this.kernel.sys;
    const nonblock = (fdflags & FDFLAGS.NONBLOCK) !== 0;
    let fd: number | undefined;
    let kind: KernelFdKind;
    if (path === SEALED_PATH && openSealed) {
      fd = this.openCharDevice(openSealed, oflags, rights);
      kind = 'sealed';
    } else if (path === CLIPBOARD_PATH && openClipboard) {
      fd = this.openCharDevice(openClipboard, oflags, rights);
      kind = 'clipboard';
    } else if (path === '/dev/tty' || /^\/dev\/tty\d+$/.test(path)) {
      const exclusive = (oflags & OFLAGS.CREAT) !== 0 && (oflags & OFLAGS.EXCL) !== 0;
      try {
        fd = openTty?.call(this.kernel.sys, path === '/dev/tty' ? undefined : path);
      } catch (err) {
        if (exclusive && (err as { code?: string }).code === 'EACCES')
          throw new WasiError('EEXIST');
        throw err;
      }
      if (fd === undefined) throw new WasiError('ENXIO');
      if (exclusive) {
        this.kernel.sys.close(fd);
        throw new WasiError('EEXIST');
      }
      kind = 'tty';
    } else return undefined;
    this.adopt(fd, kind, nonblock);
    return fd;
  }

  private openCharDevice(
    openDevice: (flags: number) => number,
    oflags: number,
    rights: bigint
  ): number {
    if (oflags & OFLAGS.DIRECTORY) throw new WasiError('ENOTDIR');
    if (oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) throw new WasiError('EEXIST');
    const want = wantOf(oflags, rights);
    const flags = want === 6 ? O_RDWR : want === 2 ? O_WRONLY : 0;
    return openDevice.call(this.kernel.sys, flags);
  }

  open(path: string, oflags: number, rights: bigint, fdflags: number, mode?: number): number {
    this.made = undefined;
    this.created = false;
    const exclusive = (oflags & OFLAGS.CREAT) !== 0 && (oflags & OFLAGS.EXCL) !== 0;
    if (exclusive && namedDevice(path)) throw new WasiError('EEXIST');
    const device = deviceOf(path);
    if (device) return this.install({ type: 'device', device });

    const kernelDevice = this.openKernelDevice(path, oflags, fdflags, rights);
    if (kernelDevice !== undefined) return kernelDevice;
    const alias = stdioAlias(path);
    if (alias !== undefined) return this.reopen(alias);
    const outside = this.escaped(path, oflags, rights);
    if (outside !== undefined) return this.open(outside, oflags, rights, fdflags, mode);
    if (exclusive && !(oflags & OFLAGS.DIRECTORY) && this.madeAtOnce(path, mode)) {
      return this.regular(path, undefined, oflags, rights, fdflags, mode, true);
    }
    if (exclusive && this.isLink(path)) throw new WasiError('EEXIST');
    const s = this.statOrMissing(path);
    if (exclusive && s) throw new WasiError('EEXIST');
    if (s?.escape !== undefined) {
      refuseWrite({ readonly: true }, oflags, rights);
      return this.open(s.escape, oflags, rights, fdflags, mode);
    }
    if (oflags & OFLAGS.DIRECTORY && !s?.isDirectory) {
      throw new WasiError(s ? 'ENOTDIR' : 'ENOENT');
    }
    if (s?.isDirectory) {
      const asked = (oflags & OFLAGS.DIRECTORY) === 0 && (rights & RIGHTS.FD_WRITE) !== 0n;
      if (asked || (oflags & (OFLAGS.CREAT | OFLAGS.TRUNC)) !== 0) throw new WasiError('EISDIR');
      return this.install({ type: 'dir', path });
    }
    if (!s && !(oflags & OFLAGS.CREAT)) throw new WasiError('ENOENT');
    refuseWrite(s, oflags, rights);
    return this.regular(path, s, oflags, rights, fdflags, mode);
  }

  private escaped(path: string, oflags: number, rights: bigint): string | undefined {
    const outside = this.fs.escape?.(path);
    if (outside === undefined) return undefined;
    refuseWrite({ readonly: true }, oflags | (oflags & OFLAGS.CREAT ? OFLAGS.TRUNC : 0), rights);
    return outside;
  }

  private regular(
    path: string,
    s: SyncFsBridgeStat | undefined,
    oflags: number,
    rights: bigint,
    fdflags: number,
    mode?: number,
    created = false
  ): number {
    if (s?.isFifo) return this.kernelFifo(path, s, oflags, rights, fdflags);
    if (s?.isSocket) throw new WasiError('ENXIO');
    if (this.shared || this.kernelHolds(path, s)) {
      return this.kernelFile(path, s, oflags, rights, fdflags, mode, created);
    }
    return this.install({
      type: 'file',
      file: this.file(path, s, oflags, rights, fdflags, mode, created),
    });
  }

  private kernelHolds(path: string, st: SyncFsBridgeStat | undefined): boolean {
    for (const [fd, e] of this.table) {
      if (e.type !== 'kernel' || this.kind(fd, e) !== 'file') continue;
      this.named(fd, e);
      if (e.path === path || (st?.ino !== undefined && e.ino === st.ino)) return true;
    }
    return false;
  }

  private readonly learned = new WeakSet<object>();

  private named(fd: number, e: { path?: string; ino?: number }): void {
    if (e.path !== undefined || this.learned.has(e)) return;
    this.learned.add(e);
    try {
      const vfs = this.kernel.call({ op: 'fd-vfs-stat', fd, identity: true }) as {
        path?: string;
        orphan?: true;
        ino?: number;
      };
      if (vfs.orphan || vfs.path === undefined) return;
      e.path = vfs.path;
      e.ino = vfs.ino ?? this.inoOf(vfs.path);
    } catch {}
  }

  private file(
    path: string,
    existing: SyncFsBridgeStat | undefined,
    oflags: number,
    rights: bigint,
    fdflags: number,
    mode?: number,
    created = false
  ): LocalFile {
    const { readable, writable } = openAccess(existing, oflags, rights);
    this.followRenames();
    let buffer = created ? undefined : this.buffers.get(path);
    if (buffer?.handle !== undefined && this.fs.kept?.(buffer.handle)) {
      this.buffers.delete(path);
      buffer = undefined;
    }
    buffer ??= this.sharing(path, existing);
    const want = wantOf(oflags, rights);
    if (buffer) {
      if (this.fs.owners) this.fs.access?.(path, want, 'open');
      if (oflags & OFLAGS.TRUNC) buffer.truncate(0);
    } else {
      buffer = this.freshBuffer(path, existing, oflags, want, mode, created);
    }
    buffer.opens++;
    const file = new LocalFile(buffer, readable, writable, (fdflags & FDFLAGS.APPEND) !== 0);
    file.ino = existing?.ino;
    return file;
  }

  private freshBuffer(
    path: string,
    existing: SyncFsBridgeStat | undefined,
    oflags: number,
    want: number,
    mode?: number,
    created = false
  ): FileBuffer {
    const made = created || (!existing && this.createNew(path, oflags, mode));
    const reply = made ? this.made : undefined;
    this.made = undefined;
    const empty = made || (oflags & OFLAGS.TRUNC) !== 0;
    if (existing?.ranged) (this.fs as { invalidate?(): void }).invalidate?.();
    const seen = reply ? reply.seen : this.fs.changes?.now();
    const st = reply?.st ?? (existing?.ranged || !existing ? this.fs.stat(path) : existing);
    const ranged = st.ranged ? st.size : undefined;
    const asked =
      (want & 4 ? HOLD_READ : 0) | (want & 2 ? HOLD_WRITE : 0) | (made ? HOLD_CREATED : 0);
    const handle = this.fs.hold?.(path, true, true, undefined, this.fs.owners ? asked : 0, {
      gen: st.gen,
    });
    const io = handle !== undefined && this.fs.pinned ? this.fs.pinned(handle) : this.fs;
    const view = this.fs.changes;
    const watch =
      view &&
      linkedWatch(
        {
          view,
          ino: st.ino,
          seen,
          stat: (at: string) => {
            (this.fs as { invalidate?(): void }).invalidate?.();
            return this.fs.stat(at);
          },
          real: () => realOf(this.fs, path),
        },
        st
      );
    const buffer = new FileBuffer(io, path, empty, st.maxFile, ranged, st.version, watch);
    buffer.moved = () => this.followRenames();
    buffer.handle = handle;
    this.buffers.set(path, buffer);
    const id = this.identity(st);
    if (id !== undefined) this.know(buffer, id);
    return buffer;
  }

  private kernelFile(
    path: string,
    existing: SyncFsBridgeStat | undefined,
    oflags: number,
    rights: bigint,
    fdflags: number,
    mode?: number,
    created = false
  ): number {
    const { readable, writable } = openAccess(existing, oflags, rights);
    const append = (fdflags & FDFLAGS.APPEND) !== 0;
    const flags = (writable ? (readable ? O_RDWR : O_WRONLY) : 0) | (append ? O_APPEND : 0);

    const made = created || (!existing && this.createNew(path, oflags, mode));

    const truncate = made || (oflags & OFLAGS.TRUNC) !== 0;
    const fd = this.kernel.sys.openVfs(path, flags, 0, {
      ...(truncate ? { truncate } : {}),
      ...(made ? { created: true } : {}),
    });
    const ino = writable ? (this.openedIno(fd) ?? this.inoOf(path)) : undefined;
    if (truncate) (this.fs as { touched?(path?: string, ino?: number): void }).touched?.(path, ino);
    this.table.set(fd, { type: 'kernel', kind: 'file', nonblock: false, append, path, ino });
    if (append) this.publishFlags(fd, { nonblock: false, append });
    this.bump(fd);
    return fd;
  }

  private kernelFifo(
    path: string,
    existing: SyncFsBridgeStat,
    oflags: number,
    rights: bigint,
    fdflags: number
  ): number {
    const { readable, writable } = openAccess(existing, oflags, rights);
    const nonblock = (fdflags & FDFLAGS.NONBLOCK) !== 0;
    const access = writable ? (readable ? O_RDWR : O_WRONLY) : 0;
    const fd = this.restarting(() =>
      this.kernel.sys.openVfs(path, access | (nonblock ? O_NONBLOCK : 0), 0, { fifo: true })
    );
    this.table.set(fd, { type: 'kernel', kind: 'stream', nonblock, append: false });
    if (nonblock) this.publishFlags(fd, { nonblock, append: false });
    this.bump(fd);
    return fd;
  }

  restartable: (() => boolean) | undefined;

  restarting<T>(call: () => T): T {
    for (;;) {
      try {
        return call();
      } catch (err) {
        if ((err as { code?: unknown }).code !== 'EINTR' || !this.restartable?.()) throw err;
      }
    }
  }

  created = false;

  private made: { st: SyncFsBridgeStat; seen: number | undefined } | undefined;

  private creating(path: string, mode?: number): void {
    const st = this.fs.create?.(path, mode, true);
    this.made = st ? { st, seen: st.seen } : undefined;
    this.created = true;
  }

  private madeAtOnce(path: string, mode?: number): boolean {
    if (!this.fs.create) return false;
    try {
      this.creating(path, mode);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') throw err;
      return false;
    }
  }

  private createNew(path: string, oflags: number, mode?: number): boolean {
    if (!this.fs.create) {
      this.fs.writeFile(path, new Uint8Array(0));
      this.created = true;
      return true;
    }
    try {
      this.creating(path, mode);
      return true;
    } catch (err) {
      if (oflags & OFLAGS.EXCL || (err as { code?: string }).code !== 'EEXIST') throw err;
      return false;
    }
  }

  private isLink(path: string): boolean {
    try {
      return this.fs.lstat(path).isSymbolicLink === true;
    } catch {
      return false;
    }
  }

  private statOrMissing(path: string): SyncFsBridgeStat | undefined {
    try {
      return this.fs.stat(path);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  private reopen(fd: number): number {
    const e = this.get(fd);
    if (e.type === 'kernel') {
      const at = this.kernel.call({ op: 'fd-dup', fd }) as number;
      this.table.set(at, { ...e });
      this.bump(at);
      return at;
    }
    if (e.type === 'file') e.file.refs++;
    return this.install(e.type === 'file' ? e : { ...e });
  }
}

function kernelEntry(): Extract<WasiEntry, { type: 'kernel' }> {
  return { type: 'kernel', nonblock: false, append: false };
}

const GEN = 2;

function ringed(shared: Int32Array): boolean {
  return shared.length >= FD_RING + FD_RING_SIZE * 2;
}

function deviceEntry(meta: DeviceMeta): Extract<WasiEntry, { type: 'device' }> {
  return { type: 'device', device: meta.device, ...(meta.access ? { access: meta.access } : {}) };
}

function refuseWrite(s: { readonly?: boolean } | undefined, oflags: number, rights: bigint): void {
  const writes = (rights & RIGHTS.FD_WRITE) !== 0n || (oflags & OFLAGS.TRUNC) !== 0;
  if (s?.readonly && writes) throw new WasiError('EROFS');
}

function preopenOf(e: { preopen?: string; twin?: number }): { preopen?: string; twin?: number } {
  return {
    ...(e.preopen ? { preopen: e.preopen } : {}),
    ...(e.twin !== undefined ? { twin: e.twin } : {}),
  };
}

function metaOf(e: WasiEntry): HeldMeta | undefined {
  if (e.type === 'dir') return { dir: e.path, ...preopenOf(e) };
  if (e.type === 'device') return { device: e.device, ...(e.access ? { access: e.access } : {}) };
  return undefined;
}

function entryOf(info: FdInfo): WasiEntry | undefined {
  if (info.meta && 'dir' in info.meta) {
    return { type: 'dir', path: info.meta.dir, ...preopenOf(info.meta) };
  }
  if (info.meta && 'device' in info.meta) return deviceEntry(info.meta);
  if (info.kind === 'held') return undefined;
  return {
    type: 'kernel',
    kind: info.kind,
    dgram: info.dgram === true,
    nonblock: ((info.flags ?? 0) & O_NONBLOCK) !== 0,
    append: ((info.flags ?? 0) & O_APPEND) !== 0,
  };
}

function wantOf(oflags: number, rights: bigint): number {
  const write = (rights & RIGHTS.FD_WRITE) !== 0n || (oflags & OFLAGS.TRUNC) !== 0;
  const read = (rights & RIGHTS.FD_READ) !== 0n || !write;
  return (read ? 4 : 0) | (write ? 2 : 0);
}

function openAccess(
  existing: SyncFsBridgeStat | undefined,
  oflags: number,
  rights: bigint
): { readable: boolean; writable: boolean } {
  const readonly = existing?.readonly === true;
  const mutating = readonly ? OFLAGS.TRUNC : OFLAGS.CREAT | OFLAGS.TRUNC;
  const writable = (rights & RIGHTS.FD_WRITE) !== 0n || (oflags & mutating) !== 0;
  if (writable && readonly) throw new WasiError('EROFS');
  return { readable: (rights & RIGHTS.FD_READ) !== 0n || !writable, writable };
}

function promoteRequest(
  fd: number,
  f: LocalFile,
  handed: ReadonlySet<FileBuffer>
): Extract<WasmSyscall, { op: 'fd-promote' }> {
  const orphan = f.buffer.isOrphan() || (f.buffer.handle ?? 0) < 0;
  if (!orphan && f.buffer.isRanged) f.buffer.flush();
  const joins = !orphan && (handed.has(f.buffer) || f.buffer.isRanged);
  return {
    op: 'fd-promote',
    fd,
    path: f.path,
    flags: (f.writable ? (f.readable ? O_RDWR : O_WRONLY) : 0) | (f.append ? O_APPEND : 0),
    position: f.offset,
    ...(joins ? {} : { contents: f.buffer.contents() }),
    ...(orphan ? { orphan: true } : {}),
    ...(!orphan && f.buffer.pin !== undefined
      ? { pin: { version: f.buffer.pin, size: f.buffer.size() } }
      : {}),

    ...(!joins && f.buffer.isDirty() ? { dirty: true } : {}),
    ...(f.buffer.handle !== undefined ? { handle: f.buffer.handle } : {}),
    ...(f.buffer.handle !== undefined && f.ino !== undefined ? { ino: f.ino } : {}),
  };
}
