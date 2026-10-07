import type { FsStat, KernelFs } from '../fs/types.ts';
import { resolveSyncFsToken } from './sync-fs-token-registry.ts';
import {
  type SyncFsRequest,
  type SyncFsResult,
  type SyncFsUsage,
  syncError,
} from './sync-fs-wire.ts';

export function toErrno(err: unknown): SyncFsResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return { ok: false, errno: code, message };
  }
  return { ok: false, errno: 'EIO', message };
}

export interface SyncFsStatJson {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  ino: number;
  dev?: number;
}

function statJson(s: FsStat): SyncFsStatJson {
  return {
    isDirectory: s.isDirectory,
    isFile: s.isFile,
    isSymbolicLink: s.isSymbolicLink,
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtime.getTime(),
    atimeMs: s.atime.getTime(),
    ctimeMs: s.ctime.getTime(),
    ino: s.ino,
    ...(s.dev !== undefined ? { dev: s.dev } : {}),
  };
}

async function readdirStat(
  fs: KernelFs,
  dir: string
): Promise<Array<[string, SyncFsStatJson | null]>> {
  return (await fs.readdirStat(dir)).map(([name, stat]) => [name, stat && statJson(stat)]);
}

async function storageUsage(): Promise<SyncFsUsage | null> {
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  if (typeof estimate?.quota !== 'number') return null;
  return { quota: estimate.quota, usage: estimate.usage ?? 0 };
}

const done: SyncFsResult = { ok: true, kind: 'void' };

function json(value: unknown): SyncFsResult {
  return { ok: true, kind: 'json', json: value };
}

async function run(
  fs: KernelFs,
  path: string,
  req: SyncFsRequest,
  cwd: string
): Promise<SyncFsResult> {
  switch (req.op) {
    case 'read':
      return { ok: true, kind: 'bytes', bytes: await fs.readFileBuffer(path) };
    case 'write':
      await fs.writeFile(path, req.body ?? new Uint8Array(0));
      return done;
    case 'exists':
      return json(await fs.exists(path));
    case 'stat':
      return json(statJson(await fs.stat(path)));
    case 'lstat':
      return json(statJson(await fs.lstat(path)));
    case 'readdir':
      return json(await fs.readdir(path));
    case 'readdir-stat':
      return json(await readdirStat(fs, path));
    case 'mkdir':
      await fs.mkdir(path, { recursive: true });
      return done;
    case 'rm':
      await fs.rm(path, { recursive: true });
      return done;
    case 'rename':
      await fs.rename(path, fs.resolvePath(cwd, req.arg2 ?? ''));
      return done;
    case 'unlink':
      if ((await fs.lstat(path)).isDirectory) throw syncError('EISDIR', path);
      await fs.rm(path);
      return done;
    case 'rmdir':
      if (!(await fs.lstat(path)).isDirectory) throw syncError('ENOTDIR', path);
      if ((await fs.readdir(path)).length > 0) throw syncError('ENOTEMPTY', path);
      await fs.rm(path, { recursive: true });
      return done;
    case 'symlink':
      await fs.symlink(req.arg2 ?? '', path);
      return done;
    case 'readlink':
      return json(await fs.readlink(path));
    case 'chmod':
      await fs.chmod(path, req.mode ?? 0);
      return done;
    case 'utimes':
      await fs.utimes(path, new Date(req.atimeMs ?? 0), new Date(req.mtimeMs ?? 0));
      return done;
    default:
      return { ok: false, errno: 'EINVAL', message: `sync-fs: unknown op '${req.op as string}'` };
  }
}

export async function dispatchSyncFs(req: SyncFsRequest): Promise<SyncFsResult> {
  const entry = resolveSyncFsToken(req.token);
  if (!entry) return { ok: false, errno: 'EACCES', message: 'sync-fs: unknown or revoked token' };
  const { fs, cwd } = entry;
  try {
    const path = fs.resolvePath(cwd, req.path);
    if (req.op === 'statfs') return json((await entry.statfs?.(path)) ?? (await storageUsage()));
    if (req.op === 'hold') {
      entry.hold?.(path, req.mode === 1);
      return done;
    }
    return await run(fs, path, req, cwd);
  } catch (err) {
    return toErrno(err);
  }
}
