import { permOf, R_OK, trustedLink, W_OK, walk } from '../fs/access.ts';
import {
  chmodMode,
  deny,
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
  writable,
} from '../fs/dac.ts';
import { devRemoval } from '../fs/dev-removal.ts';
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
import { joinName, realTarget } from '../fs/walk.ts';
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

async function usageAt(entry: SyncFsTokenEntry, path: string): Promise<SyncFsUsage | undefined> {
  if (!entry.statfs) return undefined;
  const real = await realTarget(entry.fs, path).catch(() => path);
  return entry.statfs(real);
}

async function storageUsage(): Promise<SyncFsUsage | null> {
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  if (typeof estimate?.quota !== 'number') return null;
  return { quota: estimate.quota, usage: estimate.usage ?? 0 };
}

const PLAIN_DIR_MODE = 0o755;
const done: SyncFsResult = { ok: true, kind: 'void' };

function json(value: unknown): SyncFsResult {
  return { ok: true, kind: 'json', json: value };
}

function ownerFor(entry: SyncFsTokenEntry, mode?: number): NewOwner | undefined {
  const cred = entry.cred?.();
  if (!cred) return undefined;
  return ownerOf(cred, mode === undefined ? undefined : mode & ~(entry.umask?.() ?? 0o022));
}

function plainDirMode(entry: SyncFsTokenEntry, mode: number | undefined): number | undefined {
  if (entry.cred || mode === undefined) return undefined;
  const wanted = mode & 0o7777 & ~(entry.umask?.() ?? 0o022);
  return wanted === PLAIN_DIR_MODE ? undefined : wanted;
}

function plainParentsMode(entry: SyncFsTokenEntry): number | undefined {
  if (entry.cred) return undefined;
  const wanted = (0o777 & ~(entry.umask?.() ?? 0o022)) | 0o300;
  return wanted === PLAIN_DIR_MODE ? undefined : wanted;
}

async function missingParents(
  fs: KernelFs,
  path: string,
  mode: number
): Promise<() => Promise<void>> {
  const parts = path.split('/').filter(Boolean);
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const p = `/${parts.slice(0, i).join('/')}`;
    if (!(await fs.exists(p))) dirs.push(p);
  }
  return async () => {
    for (const p of dirs) await fs.chmod(p, mode);
  };
}

function mkdirOptions(entry: SyncFsTokenEntry, mode = 0o777) {
  const owner = ownerFor(entry, mode);
  if (!owner) return { recursive: true };
  const parents = (0o777 & ~(entry.umask?.() ?? 0o022)) | 0o300;
  return { recursive: true, owner: { ...owner, parents } };
}

async function mkdirExclusive(entry: SyncFsTokenEntry, path: string, mode?: number) {
  const owner = ownerFor(entry, mode ?? 0o777);
  await entry.fs.mkdir(path, owner ? { owner } : {});
}

async function chown(entry: SyncFsTokenEntry, path: string, req: SyncFsRequest) {
  const real = req.handle !== undefined ? await keptOr(entry, path, req.handle) : path;
  const cred = entry.cred?.();
  if (!cred) {
    await (req.op === 'chown' ? entry.fs.stat(real) : entry.fs.lstat(real));
    return done;
  }
  await chownAs(entry.fs, cred, real, {
    ...(req.uid !== undefined ? { uid: req.uid } : {}),
    ...(req.gid !== undefined ? { gid: req.gid } : {}),
    follow: req.op === 'chown',
  });
  return done;
}

async function runMkdir(
  entry: SyncFsTokenEntry,
  path: string,
  req: SyncFsRequest
): Promise<SyncFsResult> {
  const { fs } = entry;
  const plain = plainDirMode(entry, req.mode);
  const parentsMode = !req.exclusive ? plainParentsMode(entry) : undefined;
  const fixParents =
    parentsMode !== undefined ? await missingParents(fs, path, parentsMode) : undefined;
  const fresh = plain !== undefined && !(await fs.exists(path));
  await (req.exclusive
    ? mkdirExclusive(entry, path, req.mode)
    : fs.mkdir(path, mkdirOptions(entry, req.mode)));
  await fixParents?.();
  if (fresh) await fs.chmod(path, plain);
  return done;
}

function readSource(entry: SyncFsTokenEntry, path: string): Promise<Uint8Array> {
  const plain = () => entry.fs.readFileBuffer(path);
  return entry.source ? entry.source.read(path, plain) : plain();
}

async function run(
  entry: SyncFsTokenEntry,
  path: string,
  req: SyncFsRequest
): Promise<SyncFsResult> {
  const { fs, cwd } = entry;
  switch (req.op) {
    case 'read':
      return { ok: true, kind: 'bytes', bytes: await readSource(entry, path) };
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
      return runMkdir(entry, path, req);
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
      await fs.rm(path, { file: true });
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
      if (req.opening) entry.created?.add(path);
      entry.fresh?.(path);
      return done;
    case 'readlink':
      return json(await fs.readlink(path));
    case 'chmod': {
      const g = guardOf(entry);
      await fs.chmod(path, g ? await chmodMode(g, path, req.mode ?? 0) : (req.mode ?? 0));
      return done;
    }
    case 'utimes':
      await fs.utimes(path, ...(await timesOf(entry, path, req)));
      return done;
    case 'lutimes':
      await lutimesOf(fs, path, ...(await timesOf(entry, path, req)));
      return done;
    case 'chown':
    case 'lchown':
      return chown(entry, path, req);
    case 'pread':
    case 'pwrite':
    case 'truncate':
      return ranged(fs, path, req);
    case 'append':
      return json(await appended(fs, path, req.body ?? new Uint8Array(0)));
    default:
      return { ok: false, errno: 'EINVAL', message: `sync-fs: unknown op '${req.op as string}'` };
  }
}

async function timesOf(
  entry: SyncFsTokenEntry,
  path: string,
  req: SyncFsRequest
): Promise<[Date, Date]> {
  const given: [Date, Date] = [new Date(req.atimeMs ?? 0), new Date(req.mtimeMs ?? 0)];
  const g = req.now === true ? guardOf(entry) : undefined;
  if (!g || g.cred.euid === 0) return given;
  const look = req.op === 'lutimes' ? entry.fs.lstat : entry.fs.stat;
  const st = await look.call(entry.fs, path).catch(() => undefined);
  if (!st || (st.uid ?? 0) === g.cred.euid) return given;
  const now = new Date();
  const kept = (ms: number | undefined, stored: Date) => (ms === stored.getTime() ? stored : now);
  return [kept(req.atimeMs, st.atime), kept(req.mtimeMs, st.mtime)];
}

export function guardOf(entry: SyncFsTokenEntry): Guard | undefined {
  const cred = entry.dac && entry.cred?.();
  if (!cred || !entry.dac) return undefined;
  const links = entry.links === undefined ? {} : { links: entry.links };
  return { fs: entry.fs, cred, pid: entry.pid ?? 0, dac: entry.dac, ...links };
}

const FOLLOWING = new Set<SyncFsOp>(['exists', 'stat', 'chown', 'statfs']);
const LOOKS = new Set<SyncFsOp>(['exists', 'stat', 'lstat']);
const NOT_FOLLOWING = new Set<SyncFsOp>(['lstat', 'readlink', 'lchown']);

async function walkSafe(g: Guard, path: string, follow: boolean): Promise<string> {
  try {
    const walked = await walk(g.fs, g.cred, path, follow, g.links);
    return walked.path;
  } catch {
    return path;
  }
}

interface GuardPaths {
  path: string;
  arg2?: string;
}

async function guard(
  g: Guard,
  path: string,
  req: SyncFsRequest,
  cwd: string
): Promise<GuardPaths | undefined> {
  const { op } = req;
  if (FOLLOWING.has(op) || NOT_FOLLOWING.has(op)) {
    const walked = await need(g, op, path, 0, { follow: FOLLOWING.has(op) });
    return { path: walked.path };
  }
  const other = () => g.fs.resolvePath(cwd, req.arg2 ?? '');
  switch (op) {
    case 'readdir':
    case 'readdir-stat': {
      await listable(g, op, path);
      const w = await walkSafe(g, path, true);
      return { path: w };
    }
    case 'mkdir': {
      await makeIn(g, op, path);
      return { path: await walkSafe(g, path, false) };
    }
    case 'create':
    case 'symlink':
      await inParent(g, op, path);
      return { path: await walkSafe(g, path, op === 'create') };
    case 'unlink':
    case 'rmdir': {
      await inParent(g, op, path, true);
      const w = await walkSafe(g, path, false);
      return { path: w };
    }
    case 'rm': {
      await removable(g, op, path);
      const w = await walkSafe(g, path, false);
      return { path: w };
    }
    case 'rename': {
      const to = other();
      await renamable(g, path, to);
      const fromWalked = await walkSafe(g, path, false);
      const toWalked = await walkSafe(g, to, false);
      return { path: fromWalked, arg2: toWalked };
    }
    case 'link': {
      const to = other();
      const follow = req.mode === 1;
      await linkable(g, path, to, follow);
      const fromWalked = await walkSafe(g, path, follow);
      const toWalked = await walkSafe(g, to, false);
      return { path: fromWalked, arg2: toWalked };
    }
    case 'utimes':
    case 'lutimes': {
      await retimable(g, op, path, req.now === true);
      const follow = op === 'utimes';
      const w = await walkSafe(g, path, follow);
      return { path: w };
    }
    case 'read':
    case 'pread':
      if (req.handle === undefined) await readable(g, op, path);
      return { path: await walkSafe(g, path, true) };
    case 'pwrite':
    case 'append':
    case 'truncate':
      if (req.handle === undefined) await fileWritable(g, op, path);
      return { path: await walkSafe(g, path, true) };
    case 'write':
      if (req.handle === undefined && req.mode !== 1) await writable(g, op, path);
      return { path: await walkSafe(g, path, true) };
    default:
      return { path: await walkSafe(g, path, true) };
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
    await entry.source?.open(path, real);
    return json(entry.hold?.(path, on, open, real) ?? null);
  }
  entry.hold?.(path, on, open, undefined, req.handle);
  return done;
}

async function followed(g: Guard, path: string) {
  const st = await g.fs.lstat(path).catch(() => undefined);
  if (st?.isSymbolicLink && !trustedLink(permOf(st), g.links)) deny(g, 'follow', path);
  return done;
}

async function accessOp(entry: SyncFsTokenEntry, path: string, req: SyncFsRequest) {
  const g = guardOf(entry);
  if (!g) return done;
  if (req.arg2 === 'follow') return followed(g, path);
  const open = req.arg2 === 'open';
  const cred = open || req.arg2 === 'eaccess' ? g.cred : realIds(g.cred);
  const options = { follow: req.nofollow !== true, ...(open ? { directory: false } : {}) };
  await need({ ...g, cred }, open ? 'open' : 'access', path, req.mode ?? 0, options);
  return done;
}

const CHANGING = new Set<SyncFsOp>([
  'mkdir',
  'create',
  'symlink',
  'unlink',
  'rmdir',
  'rm',
  'rename',
  'link',
  'utimes',
  'lutimes',
  'chmod',
  'chown',
  'lchown',
]);

const CONTENT = new Set<SyncFsOp>(['write', 'pwrite', 'append', 'truncate']);

const REMOVING = new Set<SyncFsOp>(['unlink', 'rmdir', 'rm', 'rename']);

async function mayChange(entry: SyncFsTokenEntry, path: string, req: SyncFsRequest) {
  const { mayChange } = entry.fs;
  if (!mayChange) return;
  const { op } = req;
  if (CONTENT.has(op) && req.handle === undefined) return mayChange.call(entry.fs, path, true);
  if (!CHANGING.has(op)) return;
  const follow = op === 'utimes' || op === 'chmod' || op === 'chown';
  await mayChange.call(entry.fs, path, follow, REMOVING.has(op));
  if (op === 'rename' || op === 'link') {
    const to = entry.fs.resolvePath(entry.cwd, req.arg2 ?? '');
    await mayChange.call(entry.fs, to, false, op === 'rename');
  }
}

async function guarded(
  entry: SyncFsTokenEntry,
  path: string,
  req: SyncFsRequest
): Promise<{ refused: SyncFsResult } | { paths?: GuardPaths }> {
  const g = guardOf(entry);
  if (!g) return {};
  if (LOOKS.has(req.op) && (await entry.holdsKept?.(path))) return {};
  try {
    await mayChange(entry, path, req);
    const paths = await guard(g, path, req, entry.cwd);
    return { paths };
  } catch (err) {
    const refusal = (err as { code?: unknown }).code === 'EACCES';
    const refused = req.op === 'exists' && refusal ? json(false) : toErrno(err);
    return { refused };
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

const appending = new Map<string, Promise<unknown>>();

async function appended(fs: KernelFs, path: string, body: Uint8Array): Promise<number> {
  const key = (await fs.realpath?.(path, true).catch(() => undefined)) ?? path;
  const before = appending.get(key) ?? Promise.resolve();
  const run = before.then(async () => {
    if (fs.append) return fs.append(path, body);
    const size = (await fs.stat(path)).size;
    const ops = rangedOps(fs);
    if (ops) await ops.pwrite(path, size, body, true);
    else {
      const whole = new Uint8Array(size + body.length);
      whole.set(await fs.readFileBuffer(path));
      whole.set(body, size);
      await fs.writeFile(path, whole);
    }
    return size + body.length;
  });
  const settled = run.catch(() => undefined);
  appending.set(key, settled);
  void settled.then(() => {
    if (appending.get(key) === settled) appending.delete(key);
  });
  return run;
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

const CHOWN_OPS = new Set<SyncFsOp>(['chown', 'lchown']);
const UNLINKED_OPS = new Set<SyncFsOp>(['read', 'pread', 'pwrite', 'append', 'truncate']);
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

const DENIED: ReadonlySet<string> = new Set(['EACCES', 'EPERM']);

async function rmPermitted(
  entry: SyncFsTokenEntry,
  path: string,
  req: SyncFsRequest,
  refused: SyncFsResult
): Promise<SyncFsResult> {
  const st = await entry.fs.lstat(path).catch(() => undefined);
  if (!st?.isDirectory) return refused;
  const unlisted = await guarded(entry, path, { ...req, op: 'readdir' });
  if ('refused' in unlisted) return unlisted.refused;
  const names = await entry.fs.readdir(path).catch(() => undefined);
  if (!names) return refused;
  let first: SyncFsResult | undefined;
  for (const name of names) {
    const child = await dispatchOne(entry, {
      ...req,
      path: joinName(path, name),
    });
    if (!child.ok) first ??= child;
  }
  if (first) return first;
  const g = guardOf(entry);
  if (g) {
    try {
      await inParent(g, 'rm', path, true);
    } catch (err) {
      return toErrno(err);
    }
  }
  return await run(entry, path, req);
}

async function byHandle(
  entry: SyncFsTokenEntry,
  path: string,
  req: SyncFsRequest
): Promise<SyncFsResult | undefined> {
  if (req.op === 'kept') return json(entry.keptFor?.(req.handle ?? -1) !== undefined);
  if (req.op === 'stat' && req.handle !== undefined) return keptStat(entry, req);
  if (CHOWN_OPS.has(req.op) && entry.keptFor?.(req.handle ?? -1)) return chown(entry, path, req);
  return undefined;
}

interface Resolved {
  path: string;
  arg2?: string;
  entry: SyncFsTokenEntry;
}

async function guardAndResolve(
  entry: SyncFsTokenEntry,
  path: string,
  req: SyncFsRequest
): Promise<SyncFsResult | Resolved> {
  const result = await guarded(entry, path, req);
  if ('refused' in result) return result.refused;
  const { noLinks } = entry;
  const { paths } = result;
  if (entry.links === undefined || !noLinks || !paths) return { path, entry };
  return {
    path: paths.path,
    ...(paths.arg2 ? { arg2: paths.arg2 } : {}),
    entry: { ...entry, fs: noLinks },
  };
}

const REMOVALS: ReadonlySet<SyncFsOp> = new Set<SyncFsOp>(['unlink', 'rmdir', 'rm']);

async function dispatchOne(entry: SyncFsTokenEntry, req: SyncFsRequest): Promise<SyncFsResult> {
  const { fs, cwd } = entry;
  try {
    const path = fs.resolvePath(cwd, req.path);
    const device = REMOVALS.has(req.op) ? devRemoval(path, entry.cred?.()) : undefined;
    if (device) return { ok: false, errno: device, message: `${path}: a device entry stays` };
    const held = await byHandle(entry, path, req);
    if (held) return held;
    if (req.op === 'access') return await accessOp(entry, path, req);
    if (req.op === 'hold') return await holdOp(entry, path, req);
    const resolved = await guardAndResolve(entry, path, req);
    if (!('entry' in resolved)) {
      if (req.op === 'rm' && !resolved.ok && DENIED.has(resolved.errno))
        return await rmPermitted(entry, path, req, resolved);
      return resolved;
    }
    const { path: resolvedPath, arg2: resolvedArg2, entry: opEntry } = resolved;
    const opReq = resolvedArg2 ? { ...req, arg2: resolvedArg2 } : req;
    if (req.op === 'statfs')
      return json((await usageAt(entry, resolvedPath)) ?? (await storageUsage()));
    if (entry.revoked?.(resolvedPath))
      return { ok: false, errno: 'EIO', message: `${resolvedPath} was unmounted` };
    if ((req.op === 'write' && req.mode === 1) || UNLINKED_OPS.has(req.op)) {
      const serve = async () =>
        run(opEntry, await keptOr(opEntry, resolvedPath, req.handle), opReq);
      return await (entry.gate ? entry.gate(resolvedPath, serve) : serve());
    }
    if (!entry.own || !OWN_OPS.has(req.op)) return await run(opEntry, resolvedPath, opReq);
    const target =
      resolvedArg2 ?? (TWO_PATHS.has(req.op) ? fs.resolvePath(cwd, req.arg2 ?? '') : resolvedPath);
    return await owned(opEntry, entry.own, opReq, resolvedPath, target);
  } catch (err) {
    return toErrno(err);
  }
}
