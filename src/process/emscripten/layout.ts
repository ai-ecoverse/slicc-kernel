import type { WasiMemory } from '../wasi/wasi-memory.ts';

export interface EmStat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  blocks: number;
}

export const S_IFMT = 0o170000;
export const S_IFSOCK = 0o140000;
export const S_IFLNK = 0o120000;
export const S_IFREG = 0o100000;
export const S_IFBLK = 0o060000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;

function putTime(v: DataView, at: number, ms: number): void {
  v.setBigInt64(at, BigInt(Math.floor(ms / 1000)), true);
  v.setUint32(at + 8, Math.round((ms % 1000) * 1000 * 1000) >>> 0, true);
}

export function writeStat(mem: WasiMemory, buf: number, st: EmStat): void {
  const v = mem.view();
  v.setUint32(buf, st.dev >>> 0, true);
  v.setUint32(buf + 4, st.mode >>> 0, true);
  v.setUint32(buf + 8, st.nlink >>> 0, true);
  v.setUint32(buf + 12, st.uid >>> 0, true);
  v.setUint32(buf + 16, st.gid >>> 0, true);
  v.setUint32(buf + 20, st.rdev >>> 0, true);
  v.setBigInt64(buf + 24, BigInt(st.size), true);
  v.setInt32(buf + 32, 4096, true);
  v.setInt32(buf + 36, st.blocks, true);
  putTime(v, buf + 40, st.atimeMs);
  putTime(v, buf + 56, st.mtimeMs);
  putTime(v, buf + 72, st.ctimeMs);
  v.setBigInt64(buf + 88, BigInt(st.ino), true);
}

export interface EmStatfs {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
  fsid: number;
  flags: number;
  namelen: number;
}

export function writeStatfs(mem: WasiMemory, buf: number, s: EmStatfs): void {
  const v = mem.view();
  v.setUint32(buf + 4, s.bsize, true);
  v.setUint32(buf + 60, s.bsize, true);
  v.setBigInt64(buf + 8, BigInt(s.blocks), true);
  v.setBigInt64(buf + 16, BigInt(s.bfree), true);
  v.setBigInt64(buf + 24, BigInt(s.bavail), true);
  v.setBigInt64(buf + 32, BigInt(s.files), true);
  v.setBigInt64(buf + 40, BigInt(s.ffree), true);
  v.setUint32(buf + 48, s.fsid, true);
  v.setUint32(buf + 64, s.flags, true);
  v.setUint32(buf + 56, s.namelen, true);
}

export const DIRENT_SIZE = 280;

const encoder = new TextEncoder();

export function writeDirent(
  mem: WasiMemory,
  at: number,
  ino: number,
  next: number,
  type: number,
  name: string
): void {
  const v = mem.view();
  v.setBigInt64(at, BigInt(ino), true);
  v.setBigInt64(at + 8, BigInt(next), true);
  v.setUint16(at + 16, DIRENT_SIZE, true);
  v.setUint8(at + 18, type);
  putString(mem, at + 19, name, 256);
}

export function putString(mem: WasiMemory, at: number, text: string, max: number): number {
  if (max <= 0) return 0;
  const bytes = encoder.encode(text);
  let n = Math.min(bytes.length, max - 1);
  while (n > 0 && n < bytes.length && ((bytes[n] as number) & 0xc0) === 0x80) n--;
  const out = mem.bytes(at, n + 1);
  out.set(bytes.subarray(0, n));
  out[n] = 0;
  return n;
}
