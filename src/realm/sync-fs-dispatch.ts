import { R_OK, W_OK } from '../fs/access.ts';
import {
  chmodMode,
  fileWritable,
  type Guard,
  inParent,
  linkable,
  listable,
  makeIn,
  need,
  readable,
  realIds,
  removable,
  renamable,
  retimable,
  searchable,
  writable,
} from '../fs/dac.ts';
import { chownAs, ownerOf } from '../fs/owners.ts';
import {
  type FsStat,
  type HeldEntry,
  type KernelFs,
  lutimesOf,
  mayLink,
  type NewOwner,
  rangedOps,
} from '../fs/types.ts';
import { resolveSyncFsToken, type SyncFsTokenEntry } from './sync-fs-token-registry.ts';
import {
  HOLD_CREATED,
  HOLD_READ,
  HOLD_WRITE,
  type SyncFsOp,
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
    ...(s.nlink !== undefined ? { nlink: s.nlink } : {}),
    ...(s.dev !== undefined ? { dev: s.dev } : {}),
    ...(s.readonly ? { readonly: true } : {}),
    ...(s.maxFile ? { maxFile: s.maxFile } : {}),
    ...(s.ranged ? { ranged: true } : {}),
    ...(s.linkable ? { linkable: true } : {}),
    ...(s.version !== undefined ? { version: s.version } : {}),
    ...(s.uid !== undefined ? { uid: s.uid } : {}),
    ...(s.gid !== undefined ? { gid: s.gid } : {}),
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

function ownerFor(entry: SyncFsTokenEntry, mode?: number): NewOwner | undefined {
  const cred = entry.cred?.();
  if (!cred) return undefined;
  return ownerOf(cred, mode === undefined ? undefined : mode & ~(entry.umask?.() ?? 0o022));
}

function mkdirOptions(entry: SyncFsTokenEntry, mode = 0o777) {
  const owner = ownerFor(entry, mode);
  if (!owner) return { recursive: true };
  const parents = (0o777 & ~(entry.umask?.() ?? 0o022)) | 0o300;
  return { recursive: true, owner: { ...owner, parents } };
}

async function mkdirExclusive(entry: SyncFsTokenEntry, path: string, mode?: number) {
  const { fs } = entry;
  const { owner } = mkdirOptions(entry, mode);
  const own = owner ? { owner } : {};
  try {
    await fs.mkdir(path, own);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
    const above = owner ? { owner: { ...owner, mode: owner.parents } } : {};
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true, ...above });
    await fs.mkdir(path, own);
  }
}

async function chown(entry: SyncFsTokenEntry, path: string, req: SyncFsRequest) {
  const cred = entry.cred?.();
  if (!cred) {
    await (req.op === 'chown' ? entry.fs.stat(path) : entry.fs.lstat(path));
    return done;
  }
  await chownAs(entry.fs, cred, path, {
    ...(req.uid !== undefined ? { uid: req.uid } : {}),
    ...(req.gid !== undefined ? { gid: req.gid } : {}),
    follow: req.op === 'chown',
  });
  return done;
}

async function run(
  entry: SyncFsTokenEntry,
  path: string,
  req: SyncFsRequest
): Promise<SyncFsResult> {
  const { fs, cwd } = entry;
  switch (req.op) {
    case 'read':
      return { ok: true, kind: 'bytes', bytes: await fs.readFileBuffer(path) };
    case 'write':
      await fs.writeFile(path, req.body ?? new Uint8Array(0), ownerFor(entry, 0o666));
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
      await (req.exclusive
        ? mkdirExclusive(entry, path, req.mode)
        : fs.mkdir(path, mkdirOptions(entry, req.mode)));
      return done;
    case 'rm':
      await fs.rm(path, { recursive: true });
      return done;
    case 'rename': {
      const to = fs.resolvePath(cwd, req.arg2 ?? '');
      await fs.rename(path, to);
      entry.renamed?.(path, to);
      return done;
    }
    case 'link':
      await fs.link(path, fs.resolvePath(cwd, req.arg2 ?? ''), req.mode === 1);
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
      await fs.symlink(req.arg2 ?? '', path, ownerFor(entry));
      return done;
    case 'create':
      await createExclusive(fs, path, ownerFor(entry, req.mode ?? 0o666));
      entry.created?.add(path);
      return done;
    case 'readlink':
      return json(await fs.readlink(path));
    case 'chmod': {
      const g = guardOf(entry);
      await fs.chmod(path, g ? await chmodMode(g, path, req.mode ?? 0) : (req.mode ?? 0));
      return done;
    }
    case 'utimes':
      await fs.utimes(path, new Date(req.atimeMs ?? 0), new Date(req.mtimeMs ?? 0));
      return done;
    case 'lutimes':
      await lutimesOf(fs, path, new Date(req.atimeMs ?? 0), new Date(req.mtimeMs ?? 0));
      return done;
    case 'chown':
    case 'lchown':
      return chown(entry, path, req);
    case 'pread':
    case 'pwrite':
    case 'truncate':
      return ranged(fs, path, req);
    default:
      return { ok: false, errno: 'EINVAL', message: `sync-fs: unknown op '${req.op as string}'` };
  }
}

export function guardOf(entry: SyncFsTokenEntry): Guard | undefined {
  const cred = entry.dac && entry.cred?.();
  if (!cred || !entry.dac) return undefined;
  return { fs: entry.fs, cred, pid: entry.pid ?? 0, dac: entry.dac };
}

const FOLLOWING = new Set<SyncFsOp>(['exists', 'stat', 'chown', 'statfs']);
const NOT_FOLLOWING = new Set<SyncFsOp>(['lstat', 'readlink', 'lchown']);

async function guard(g: Guard, path: string, req: SyncFsRequest, cwd: string): Promise<void> {
  const { op } = req;
  if (FOLLOWING.has(op) || NOT_FOLLOWING.has(op)) return searchable(g, op, path, FOLLOWING.has(op));
  const other = () => g.fs.resolvePath(cwd, req.arg2 ?? '');
  switch (op) {
    case 'readdir':
    case 'readdir-stat':
      return listable(g, op, path);
    case 'mkdir':
      return makeIn(g, op, path);
    case 'create':
    case 'symlink':
      return inParent(g, op, path);
    case 'unlink':
    case 'rmdir':
      return inParent(g, op, path, true);
    case 'rm':
      return removable(g, op, path);
    case 'rename':
      return renamable(g, path, other());
    case 'link':
      return linkable(g, path, other(), req.mode === 1);
    case 'utimes':
    case 'lutimes':
      return retimable(g, op, path, req.now === true);
    case 'read':
    case 'pread':
      return req.handle === undefined ? readable(g, op, path) : undefined;
    case 'pwrite':
    case 'truncate':
      return req.handle === undefined ? fileWritable(g, op, path) : undefined;
    case 'write':
      return req.handle === undefined && req.mode !== 1 ? writable(g, op, path) : undefined;
    default:
      return undefined;
  }
}

async function opening(entry: SyncFsTokenEntry, path: string, mode: number): Promise<void> {
  const g = guardOf(entry);
  const want = (mode & HOLD_READ ? R_OK : 0) | (mode & HOLD_WRITE ? W_OK : 0);
  const created = (mode & HOLD_CREATED) !== 0 && entry.created?.take(path) === true;
  if (g && want !== 0 && !created) {
    await need(g, 'open', path, want, { directory: false });
  }
}

async function holdOp(entry: SyncFsTokenEntry, path: string, req: SyncFsRequest) {
  const mode = req.mode ?? 0;
  const [on, open] = [(mode & 1) === 1, (mode & 2) === 2];
  if (on && open) {
    await opening(entry, path, mode);
    const real = await entry.fs.realpath?.(path, true).catch(() => path);
    return json(entry.hold?.(path, on, open, real) ?? null);
  }
  entry.hold?.(path, on, open, undefined, req.handle);
  return done;
}

async function accessOp(entry: SyncFsTokenEntry, path: string, req: SyncFsRequest) {
  const g = guardOf(entry);
  if (!g) return done;
  const open = req.arg2 === 'open';
  const cred = open || req.arg2 === 'eaccess' ? g.cred : realIds(g.cred);
  const options = { follow: req.nofollow !== true, ...(open ? { directory: false } : {}) };
  await need({ ...g, cred }, open ? 'open' : 'access', path, req.mode ?? 0, options);
  return done;
}

async function guarded(entry: SyncFsTokenEntry, path: string, req: SyncFsRequest) {
  const g = guardOf(entry);
  if (!g) return undefined;
  try {
    await guard(g, path, req, entry.cwd);
    return undefined;
  } catch (err) {
    const refusal = (err as { code?: unknown }).code === 'EACCES';
    return req.op === 'exists' && refusal ? json(false) : toErrno(err);
  }
}

async function createExclusive(fs: KernelFs, path: string, owner?: NewOwner): Promise<void> {
  if (fs.createExclusive) return fs.createExclusive(path, owner);
  if (
    await fs.lstat(path).then(
      () => true,
      () => false
    )
  )
    throw syncError('EEXIST', path);
  await fs.writeFile(path, new Uint8Array(0), owner);
}

async function ranged(fs: KernelFs, path: string, req: SyncFsRequest): Promise<SyncFsResult> {
  const ops = rangedOps(fs);
  if (!ops) throw syncError('ENOSYS', path);
  const offset = req.offset ?? 0;
  if (req.op === 'pread')
    return {
      ok: true,
      kind: 'bytes',
      bytes: await ops.pread(path, offset, req.length ?? 0, req.version),
    };
  if (req.op === 'pwrite') await ops.pwrite(path, offset, req.body ?? new Uint8Array(0), true);
  else await ops.truncate(path, req.length ?? 0);
  return done;
}

const UNLINKED_OPS = new Set<SyncFsOp>(['read', 'pread', 'pwrite', 'truncate']);
const OWN_OPS = new Set<SyncFsOp>(['rm', 'unlink', 'rmdir', 'rename', 'link']);
const TWO_PATHS = new Set<SyncFsOp>(['rename', 'link']);
const UNLINKING_OPS = new Set<SyncFsOp>(['rm', 'unlink', 'rename']);

async function linkedElsewhere(fs: KernelFs, path: string, from?: string): Promise<boolean> {
  if (!mayLink(fs, path)) return false;
  const st = await fs.lstat(path).catch(() => undefined);
  if (!st || (st.nlink ?? 1) < 2) return false;
  const source = from === undefined ? undefined : await fs.lstat(from).catch(() => undefined);
  return !(source && source.ino === st.ino && source.dev === st.dev);
}

async function keptOr(entry: SyncFsTokenEntry, path: string, handle?: number): Promise<string> {
  if (handle !== undefined) return entry.keptFor?.(handle)?.hidden ?? path;
  const kept = entry.unlinked?.(path);
  return kept && !(await entry.fs.exists(path)) ? kept.hidden : path;
}

async function keptStat(entry: SyncFsTokenEntry, req: SyncFsRequest): Promise<SyncFsResult> {
  const hidden = entry.keptFor?.(req.handle ?? -1)?.hidden;
  if (hidden === undefined)
    return { ok: false, errno: 'ENOENT', message: 'the handle keeps no file' };
  return json(statJson(await entry.fs.stat(hidden)));
}

async function owned(
  entry: SyncFsTokenEntry,
  own: NonNullable<SyncFsTokenEntry['own']>,
  req: SyncFsRequest,
  path: string,
  target: string
): Promise<SyncFsResult> {
  const source = target === path ? undefined : path;
  if (UNLINKING_OPS.has(req.op) && (await linkedElsewhere(entry.fs, target, source))) {
    return run(entry, path, req);
  }
  return own(target, () => run(entry, path, req));
}

const IDENTITY_OPS = new Set<SyncFsOp>([
  'write',
  'pwrite',
  'truncate',
  'chmod',
  'utimes',
  'chown',
  'lchown',
]);

export async function dispatchSyncFs(req: SyncFsRequest): Promise<SyncFsResult> {
  const entry = resolveSyncFsToken(req.token);
  if (!entry) return { ok: false, errno: 'EACCES', message: 'sync-fs: unknown or revoked token' };
  if (!req.identity || !IDENTITY_OPS.has(req.op)) return dispatchOne(entry, req);
  const { fs, cwd } = entry;
  const path = fs.resolvePath(cwd, req.path);
  const identified = async (held?: HeldEntry): Promise<SyncFsResult> => {
    const own = held ? { ...entry, fs: { ...fs, writeFile: held.writeFile } } : entry;
    const result = await dispatchOne(own, req);
    if (!result.ok) return result;
    if (held && !held.direct) return json(null);
    const look = req.op === 'lchown' ? fs.lstat : fs.stat;
    const st = await look.call(fs, path).catch(() => undefined);
    return json(st ? statJson(st) : null);
  };
  try {
    return await (fs.exclusive
      ? fs.exclusive(path, identified, req.op !== 'lchown')
      : identified());
  } catch (err) {
    return toErrno(err);
  }
}

async function dispatchOne(entry: SyncFsTokenEntry, req: SyncFsRequest): Promise<SyncFsResult> {
  const { fs, cwd } = entry;
  try {
    const path = fs.resolvePath(cwd, req.path);
    if (req.op === 'kept') return json(entry.keptFor?.(req.handle ?? -1) !== undefined);
    if (req.op === 'stat' && req.handle !== undefined) return await keptStat(entry, req);
    if (req.op === 'access') return await accessOp(entry, path, req);
    if (req.op === 'hold') return await holdOp(entry, path, req);
    const refused = await guarded(entry, path, req);
    if (refused) return refused;
    if (req.op === 'statfs') return json((await entry.statfs?.(path)) ?? (await storageUsage()));
    if (entry.revoked?.(path)) return { ok: false, errno: 'EIO', message: `${path} was unmounted` };
    if ((req.op === 'write' && req.mode === 1) || UNLINKED_OPS.has(req.op)) {
      const serve = async () => run(entry, await keptOr(entry, path, req.handle), req);
      return await (entry.gate ? entry.gate(path, serve) : serve());
    }
    if (!entry.own || !OWN_OPS.has(req.op)) return await run(entry, path, req);
    const target = TWO_PATHS.has(req.op) ? fs.resolvePath(cwd, req.arg2 ?? '') : path;
    return await owned(entry, entry.own, req, path, target);
  } catch (err) {
    return toErrno(err);
  }
}
