import type { DeviceMeta, KernelFdKind } from '../../kernel/fd-table.ts';
import type { SyncFsBridgeStat, SyncFsResult } from '../../realm/sync-fs-wire.ts';
import { JsCallError } from './js-kernel.ts';

export interface JsOpenOptions {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  create?: boolean;
  exclusive?: boolean;
  truncate?: boolean;
}

export type JsFdType = 'file' | 'pipe' | 'tty' | 'socket' | 'device' | 'directory';

export interface FdInfo {
  tty?: boolean;
  kind?: KernelFdKind;
  meta?: DeviceMeta | { dir: string };
}

export const CHUNK = 64 * 1024;
export const MAX_IO = 1024 * 1024;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;

export function typeOf(info: FdInfo): JsFdType {
  if (info.meta && 'dir' in info.meta) return 'directory';
  if (info.meta && 'device' in info.meta) return 'device';
  if (info.tty || info.kind === 'tty') return 'tty';
  if (info.kind === 'socket') return 'socket';
  return info.kind === 'file' ? 'file' : 'pipe';
}

function device(info: FdInfo): DeviceMeta | undefined {
  return info.meta && 'device' in info.meta ? info.meta : undefined;
}

export function readDevice(
  info: FdInfo,
  max: number,
  random: (bytes: Uint8Array) => void
): Uint8Array | undefined {
  if (typeOf(info) === 'directory') throw new JsCallError('EISDIR', 'read');
  const dev = device(info);
  if (!dev) return undefined;
  if (dev.access === 'write') throw new JsCallError('EBADF', 'read');
  if (dev.device === 'null') return new Uint8Array(0);
  const out = new Uint8Array(Math.min(max, CHUNK));
  if (dev.device === 'urandom') random(out);
  return out;
}

export function writeDevice(info: FdInfo): boolean {
  if (typeOf(info) === 'directory') throw new JsCallError('EISDIR', 'write');
  const dev = device(info);
  if (!dev) return false;
  if (dev.access === 'read') throw new JsCallError('EBADF', 'write');
  if (dev.device === 'full') throw new JsCallError('ENOSPC', 'write');
  return true;
}

export function brokenPipe(err: unknown, info: FdInfo): boolean {
  return err instanceof JsCallError && err.code === 'EPIPE' && typeOf(info) !== 'socket';
}

export function written(r: SyncFsResult, fallback: number): number {
  return r.ok && r.kind === 'json' && typeof r.json === 'number' ? r.json : fallback;
}

export function joined(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function fileWrite(fd: number, append: boolean, offset: number, body: Uint8Array) {
  return append
    ? { op: 'fd-write' as const, fd, body }
    : { op: 'fd-pwrite' as const, fd, offset, body };
}

export function isExclusive(o: JsOpenOptions): boolean {
  return o.create === true && o.exclusive === true;
}

export function absent(err: unknown): undefined {
  if (err instanceof JsCallError && err.code === 'ENOENT') return undefined;
  throw err;
}

export function checkOpen(abs: string, o: JsOpenOptions, existing?: SyncFsBridgeStat): void {
  if (existing && isExclusive(o)) throw new JsCallError('EEXIST', abs);
  if (!existing && !o.create) throw new JsCallError('ENOENT', abs);
  if (existing?.isDirectory) throw new JsCallError('EISDIR', abs);
}

function flagsOf(o: JsOpenOptions): number {
  const write = o.write || o.append || o.truncate;
  const access = write ? (o.read ? O_RDWR : O_WRONLY) : 0;
  return access | (o.append ? O_APPEND : 0);
}

export function openRequest(abs: string, o: JsOpenOptions) {
  return {
    op: 'fd-open-vfs' as const,
    path: abs,
    flags: flagsOf(o),
    position: 0,
    ...(isExclusive(o) ? { exclusive: true } : o.create ? { create: true } : { existing: true }),
    ...(o.truncate ? { truncate: true } : {}),
  };
}

export function index(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new JsCallError('EINVAL', what);
}
