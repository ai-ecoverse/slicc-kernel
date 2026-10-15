import type { ChangeView } from '../fs/changes.ts';
export const SYNC_FS_OPS = [
  'read',
  'write',
  'exists',
  'stat',
  'lstat',
  'readdir',
  'readdir-stat',
  'mkdir',
  'rm',
  'rename',
  'link',
  'unlink',
  'rmdir',
  'symlink',
  'readlink',
  'chmod',
  'utimes',
  'lutimes',
  'statfs',
  'hold',
  'create',
  'kept',
  'pread',
  'pwrite',
  'append',
  'truncate',
  'chown',
  'lchown',
  'access',
] as const;

export type AccessKind = 'open' | 'access' | 'eaccess' | 'follow';

export const HOLD_READ = 4;
export const HOLD_WRITE = 8;
export const HOLD_CREATED = 16;

export type SyncFsOp = (typeof SYNC_FS_OPS)[number];

export interface SyncFsRequest {
  token: string;
  op: SyncFsOp;
  path: string;
  body?: Uint8Array;
  arg2?: string;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
  offset?: number;
  length?: number;
  version?: string;
  handle?: number;
  uid?: number;
  gid?: number;
  exclusive?: boolean;
  identity?: boolean;
  now?: boolean;
  nofollow?: boolean;
  opening?: boolean;
}

export type SyncFsResult =
  | { ok: true; kind: 'bytes'; bytes: Uint8Array }
  | { ok: true; kind: 'json'; json: unknown }
  | { ok: true; kind: 'void' }
  | { ok: false; errno: string; message: string };

export const SYNC_FS_REQUEST_TIMEOUT_MS = 25_000;

export interface SyncFsBridgeStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size: number;
  mode?: number;
  mtimeMs?: number;
  atimeMs?: number;
  ctimeMs?: number;
  ino?: number;
  nlink?: number;
  dev?: number;
  readonly?: boolean;
  maxFile?: number;
  ranged?: boolean;
  linkable?: boolean;
  version?: string;
  uid?: number;
  gid?: number;
}

export interface SyncFsUsage {
  quota: number;
  usage: number;
}

export function parseSyncFsUsage(json: unknown): SyncFsUsage | null {
  const u = json as Partial<SyncFsUsage> | null;
  if (!u || typeof u.quota !== 'number' || typeof u.usage !== 'number') return null;
  return { quota: u.quota, usage: u.usage };
}

export type SyncFsFileIo = Pick<
  SyncFsPosixBridge,
  'readFile' | 'writeFile' | 'pread' | 'pwrite' | 'truncate' | 'append'
>;

export type ChownArgs = [
  uid: number | undefined,
  gid: number | undefined,
  follow?: boolean,
  handle?: number,
];

export interface SyncFsPosixBridge {
  changes?: ChangeView;
  pinned?(handle: number): SyncFsFileIo;
  kept?(handle: number): boolean;
  keptStat?(handle: number): SyncFsBridgeStat;
  readFile(path: string): Uint8Array;
  writeFile(path: string, bytes: Uint8Array, open?: boolean): void;
  stat(path: string): SyncFsBridgeStat;
  lstat(path: string): SyncFsBridgeStat;
  readdir(path: string): string[];
  exists(path: string): boolean;
  mkdir(path: string, mode?: number): void;
  rm(path: string): void;
  rename(from: string, to: string): void;
  link(from: string, to: string, follow?: boolean): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  symlink(target: string, linkPath: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  utimes(path: string, atimeMs: number, mtimeMs: number, now?: boolean): void;
  lutimes(path: string, atimeMs: number, mtimeMs: number, now?: boolean): void;
  hold?(
    path: string,
    held: boolean,
    open?: boolean,
    handle?: number,
    want?: number
  ): number | undefined;
  access?(path: string, mode: number, kind?: AccessKind, nofollow?: boolean): void;
  create?(path: string, mode?: number, opening?: boolean): void;
  chown?(path: string, ...rest: ChownArgs): void;
  owners?: boolean;
  links?: boolean;
  readdirStat(path: string): Array<[string, SyncFsBridgeStat | null]>;
  statfs?(path?: string): SyncFsUsage | null;
  pread?(path: string, offset: number, length: number, version?: string): Uint8Array;
  pwrite?(path: string, offset: number, bytes: Uint8Array, transfer?: boolean): void;
  truncate?(path: string, size: number): void;
  append?(path: string, bytes: Uint8Array): number;
  identify?(): void;
  identified?(): SyncFsBridgeStat | null;
}

export function syncError(code: string, label: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${label}`), { code });
}

export function parseSyncFsStat(json: unknown): SyncFsBridgeStat | null {
  const s = json as Partial<SyncFsBridgeStat> | null;
  if (
    !s ||
    typeof s.isFile !== 'boolean' ||
    typeof s.isDirectory !== 'boolean' ||
    typeof s.size !== 'number'
  ) {
    return null;
  }
  return {
    isFile: s.isFile,
    isDirectory: s.isDirectory,
    isSymbolicLink: s.isSymbolicLink,
    size: s.size,
    ...(typeof s.mode === 'number' ? { mode: s.mode } : {}),
    ...(typeof s.mtimeMs === 'number' ? { mtimeMs: s.mtimeMs } : {}),
    ...(typeof s.atimeMs === 'number' ? { atimeMs: s.atimeMs } : {}),
    ...(typeof s.ctimeMs === 'number' ? { ctimeMs: s.ctimeMs } : {}),
    ...(typeof s.ino === 'number' ? { ino: s.ino } : {}),
    ...(typeof s.nlink === 'number' ? { nlink: s.nlink } : {}),
    ...(typeof s.dev === 'number' ? { dev: s.dev } : {}),
    ...(s.readonly === true ? { readonly: true } : {}),
    ...(typeof s.maxFile === 'number' ? { maxFile: s.maxFile } : {}),
    ...(s.ranged === true ? { ranged: true } : {}),
    ...(s.linkable === true ? { linkable: true } : {}),
    ...(typeof s.version === 'string' ? { version: s.version } : {}),
    ...(typeof s.uid === 'number' ? { uid: s.uid } : {}),
    ...(typeof s.gid === 'number' ? { gid: s.gid } : {}),
  };
}
