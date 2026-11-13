import { wasiErrno } from '../wasi-errno.ts';

export const EM = {
  AGAIN: 6,
  BADF: 8,
  BUSY: 10,
  CHILD: 12,
  EXIST: 20,
  FAULT: 21,
  INTR: 27,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  LOOP: 32,
  MLINK: 34,
  NAMETOOLONG: 37,
  NOENT: 44,
  NOMEM: 48,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSOCK: 57,
  NOTTY: 59,
  NXIO: 60,
  OVERFLOW: 61,
  PERM: 63,
  PIPE: 64,
  RANGE: 68,
  SPIPE: 70,
  XDEV: 75,
  NOTSUP: 138,
} as const;

export class EmError extends Error {
  readonly errno: number;
  constructor(errno: number) {
    super(`errno ${errno}`);
    this.errno = errno;
  }
}

export function errnoOf(e: unknown): number | undefined {
  if (e instanceof EmError) return e.errno;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return wasiErrno(code);
  if (e instanceof RangeError) return EM.FAULT;
  return undefined;
}

export type Syscall = (...args: never[]) => number | bigint | undefined | void;

export function negated(fn: Syscall): (...args: never[]) => number {
  return (...args) => {
    try {
      return Number(fn(...args) ?? 0);
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === undefined) throw e;
      return -errno;
    }
  };
}

export function positive(fn: Syscall): (...args: never[]) => number {
  return (...args) => {
    try {
      return Number(fn(...args) ?? 0);
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === undefined) throw e;
      return errno;
    }
  };
}
