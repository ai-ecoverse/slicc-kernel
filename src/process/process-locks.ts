import { type LiveFsNode, liveNodePath } from '../realm/live-vfs-fs.ts';
import type { ProcessFs, ProcessStream } from './kernel-streams.ts';
import { wasiErrno } from './wasi-errno.ts';

export const F_GETLK = 12;
export const F_SETLK = 13;
export const F_SETLKW = 14;

const F_RDLCK = 0;
const F_WRLCK = 1;
const F_UNLCK = 2;
const SEEK_CUR = 1;
const SEEK_END = 2;
const O_ACCMODE = 3;
const O_RDONLY = 0;
const O_WRONLY = 1;

export type LockKind = 'read' | 'write';

export interface LockTarget {
  path?: string;
  fd?: number;
}

export interface LockHeld {
  kind: LockKind;
  pid: number;
  start: number;
  len: number;
}

export interface LockKernel {
  setLock(
    target: LockTarget,
    kind: LockKind | 'unlock',
    start: number,
    len: number,
    wait: boolean
  ): void;
  getLock(target: LockTarget, kind: LockKind, start: number, len: number): LockHeld | null;
  closeLocks(target: LockTarget): void;
}

export interface LockDeps {
  fs(): ProcessFs | undefined;
  memory(): ArrayBufferLike | undefined;
  kernel: LockKernel;
  flush(): void;
}

const held = new WeakMap<ProcessFs, true>();

export function lockTarget(stream: ProcessStream): LockTarget | undefined {
  if (stream.sliccKernelFile && stream.sliccKernelFd !== undefined) {
    return { fd: stream.sliccKernelFd };
  }
  const node = stream.node as unknown as Partial<LiveFsNode>;
  return node.live && node.mount ? { path: liveNodePath(node as LiveFsNode) } : undefined;
}

function errnoOf(err: unknown): number {
  const code = (err as { code?: unknown; errno?: unknown } | null)?.code;
  if (typeof code === 'string') return wasiErrno(code);
  const errno = (err as { errno?: unknown } | null)?.errno;
  return typeof errno === 'number' ? errno : wasiErrno('EIO');
}

function sizeOf(Fs: ProcessFs, stream: ProcessStream): number {
  const st = (Fs as unknown as { fstat?: (fd: number) => { size: number } }).fstat?.(stream.fd);
  return st?.size ?? 0;
}

function kindOf(type: number): LockKind | 'unlock' | undefined {
  if (type === F_RDLCK) return 'read';
  if (type === F_WRLCK) return 'write';
  return type === F_UNLCK ? 'unlock' : undefined;
}

interface Flock {
  kind: LockKind | 'unlock';
  start: number;
  len: number;
}

function readFlock(
  view: DataView,
  at: number,
  base: (whence: number) => number
): Flock | undefined {
  const kind = kindOf(view.getInt16(at, true));
  if (kind === undefined) return undefined;
  const start = base(view.getInt16(at + 2, true)) + Number(view.getBigInt64(at + 8, true));
  return { kind, start, len: Number(view.getBigInt64(at + 16, true)) };
}

function writeHolder(view: DataView, at: number, found: LockHeld | null): void {
  if (!found) {
    view.setInt16(at, F_UNLCK, true);
    return;
  }
  view.setInt16(at, found.kind === 'read' ? F_RDLCK : F_WRLCK, true);
  view.setInt16(at + 2, 0, true);
  view.setBigInt64(at + 8, BigInt(found.start), true);
  view.setBigInt64(at + 16, BigInt(found.len), true);
  view.setInt32(at + 24, found.pid, true);
}

function refused(kind: LockKind | 'unlock', flags: number): boolean {
  const access = flags & O_ACCMODE;
  return (kind === 'write' && access === O_RDONLY) || (kind === 'read' && access === O_WRONLY);
}

function baseOf(Fs: ProcessFs, stream: ProcessStream): (whence: number) => number {
  return (whence) =>
    whence === SEEK_CUR ? stream.position : whence === SEEK_END ? sizeOf(Fs, stream) : 0;
}

export function recordLock(
  fcntl: (fd: number, cmd: number, varargs: number) => number,
  deps: LockDeps
): (fd: number, cmd: number, varargs: number) => number {
  return (fd, cmd, varargs) => {
    if (cmd !== F_GETLK && cmd !== F_SETLK && cmd !== F_SETLKW) return fcntl(fd, cmd, varargs);
    const Fs = deps.fs();
    const buffer = deps.memory();
    const stream = Fs?.getStream(fd);
    const target = stream ? lockTarget(stream) : undefined;
    if (!Fs || !buffer || !stream || !target) return fcntl(fd, cmd, varargs);
    const view = new DataView(buffer);
    const at = view.getUint32(varargs, true);
    const lock = readFlock(view, at, baseOf(Fs, stream));
    if (!lock || (cmd === F_GETLK && lock.kind === 'unlock')) return -wasiErrno('EINVAL');
    try {
      if (cmd === F_GETLK) {
        writeHolder(
          view,
          at,
          deps.kernel.getLock(target, lock.kind as LockKind, lock.start, lock.len)
        );
        return 0;
      }
      if (refused(lock.kind, stream.flags)) return -wasiErrno('EBADF');
      if (lock.kind !== 'write') deps.flush();
      deps.kernel.setLock(target, lock.kind, lock.start, lock.len, cmd === F_SETLKW);
      if (lock.kind !== 'unlock') held.set(Fs, true);
      return 0;
    } catch (err) {
      return -errnoOf(err);
    }
  };
}

export function closeDropsLocks(Fs: ProcessFs, kernel: LockKernel): void {
  const close = (Fs as { close?: (stream: ProcessStream) => void }).close;
  if (typeof close !== 'function') return;
  (Fs as { close: (stream: ProcessStream) => void }).close = (stream) => {
    const target = held.has(Fs) && !stream.sliccKernelFile ? lockTarget(stream) : undefined;
    close.call(Fs, stream);
    if (!target) return;
    try {
      kernel.closeLocks(target);
    } catch {}
  };
}
