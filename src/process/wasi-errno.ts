import { E } from './wasi/wasi-abi.ts';

const WASI_ERRNO: Readonly<Partial<Record<string, number>>> = {
  ...Object.fromEntries(Object.entries(E).map(([name, errno]) => [`E${name}`, errno])),
  EWOULDBLOCK: E.AGAIN,
  ENOTSUP: 138,
  EOPNOTSUPP: 138,
  ENOMEDIUM: 148,
};

export function wasiErrno(code: string): number {
  return WASI_ERRNO[code] ?? E.IO;
}
