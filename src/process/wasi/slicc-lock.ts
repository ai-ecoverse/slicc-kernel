import type { LockHeld, LockKind, LockTarget } from '../process-locks.ts';
import { WasiError } from './wasi-files.ts';
import type { WasiFunction } from './wasi-host.ts';
import type { WasiMemory } from './wasi-memory.ts';

export const F_GETLK = 12;
export const F_SETLK = 13;
export const F_SETLKW = 14;

const F_RDLCK = 0;
const F_WRLCK = 1;
const F_UNLCK = 2;
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

export interface LockedFile {
  target: LockTarget;
  path?: string;
  readable?: boolean;
  writable?: boolean;
  offset(): number;
  size(): number;
}

const LOCK_NB = 4;
const FLOCK_OPS: Readonly<Record<number, FlockKind>> = { 1: 'shared', 2: 'exclusive', 8: 'unlock' };

export type FlockKind = 'shared' | 'exclusive' | 'unlock';

export interface LockCalls {
  set(
    target: LockTarget,
    kind: LockKind | 'unlock',
    start: number,
    len: number,
    wait: boolean
  ): void;
  get(target: LockTarget, kind: LockKind, start: number, len: number): LockHeld | null;
  flock(fd: number, kind: FlockKind, wait: boolean): void;
}

export interface LockHost {
  mem: WasiMemory;
  file(fd: number): LockedFile;
  flush(file: LockedFile): void;
  locked(): void;
  promote(fd: number, moved?: boolean): void;
  calls: LockCalls;
}

function kindOf(type: number): LockKind | 'unlock' {
  if (type === F_RDLCK) return 'read';
  if (type === F_WRLCK) return 'write';
  if (type === F_UNLCK) return 'unlock';
  throw new WasiError('EINVAL');
}

function baseOf(file: LockedFile, whence: number): number {
  if (whence === SEEK_SET) return 0;
  if (whence === SEEK_CUR) return file.offset();
  if (whence === SEEK_END) return file.size();
  throw new WasiError('EINVAL');
}

function writeHolder(view: DataView, at: number, found: LockHeld | null): void {
  if (!found) {
    view.setInt16(at, F_UNLCK, true);
    return;
  }
  view.setInt16(at, found.kind === 'read' ? F_RDLCK : F_WRLCK, true);
  view.setInt16(at + 2, SEEK_SET, true);
  view.setBigInt64(at + 8, BigInt(found.start), true);
  view.setBigInt64(at + 16, BigInt(found.len), true);
  view.setInt32(at + 24, found.pid, true);
}

export function lockImports(host: LockHost): Record<string, WasiFunction> {
  return {
    flock: (fd: number, op: number) => {
      host.promote(fd);
      const kind = FLOCK_OPS[op & ~LOCK_NB];
      if (!kind) throw new WasiError('EINVAL');
      host.calls.flock(fd, kind, kind !== 'unlock' && (op & LOCK_NB) === 0);
    },
    fcntl_lock: (fd: number, cmd: number, at: number) => {
      if (cmd !== F_GETLK && cmd !== F_SETLK && cmd !== F_SETLKW) throw new WasiError('EINVAL');
      host.promote(fd, true);
      const file = host.file(fd);
      const view = host.mem.view();
      const kind = kindOf(view.getInt16(at, true));
      const start =
        baseOf(file, view.getInt16(at + 2, true)) + Number(view.getBigInt64(at + 8, true));
      const len = Number(view.getBigInt64(at + 16, true));
      if (cmd === F_GETLK) {
        if (kind === 'unlock') throw new WasiError('EINVAL');
        writeHolder(view, at, host.calls.get(file.target, kind, start, len));
        return;
      }
      if (
        (kind === 'read' && file.readable === false) ||
        (kind === 'write' && file.writable === false)
      )
        throw new WasiError('EBADF');
      if (kind !== 'write') host.flush(file);
      host.calls.set(file.target, kind, start, len, cmd === F_SETLKW);
      if (kind !== 'unlock') host.locked();
    },
  };
}
