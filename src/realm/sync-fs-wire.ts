export type SyncFsOp =
  | 'read'
  | 'write'
  | 'exists'
  | 'stat'
  | 'lstat'
  | 'readdir'
  | 'readdir-stat'
  | 'mkdir'
  | 'rm'
  | 'rename'
  | 'unlink'
  | 'rmdir'
  | 'symlink'
  | 'readlink'
  | 'chmod'
  | 'utimes'
  | 'statfs'
  | 'hold';

export interface SyncFsRequest {
  token: string;
  op: SyncFsOp;
  path: string;
  body?: Uint8Array;
  arg2?: string;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
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
  dev?: number;
  readonly?: boolean;
  maxFile?: number;
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

export interface SyncFsPosixBridge {
  readFile(path: string): Uint8Array;
  writeFile(path: string, bytes: Uint8Array): void;
  stat(path: string): SyncFsBridgeStat;
  lstat(path: string): SyncFsBridgeStat;
  readdir(path: string): string[];
  exists(path: string): boolean;
  mkdir(path: string): void;
  rm(path: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  symlink(target: string, linkPath: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  utimes(path: string, atimeMs: number, mtimeMs: number): void;
  hold?(path: string, held: boolean): void;
  readdirStat(path: string): Array<[string, SyncFsBridgeStat | null]>;
  statfs?(path?: string): SyncFsUsage | null;
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
    ...(typeof s.dev === 'number' ? { dev: s.dev } : {}),
    ...(s.readonly === true ? { readonly: true } : {}),
    ...(typeof s.maxFile === 'number' ? { maxFile: s.maxFile } : {}),
  };
}
