import { devCreation } from '../../fs/dev-removal.ts';
import { physicalPath } from '../../fs/physical-path.ts';
import { inodeOf } from '../../fs/types.ts';
import type { Cred } from '../../kernel/cred.ts';
import { initHostname } from '../../kernel/net/loopback-names.ts';
import type { SyncFsBridgeStat } from '../../realm/sync-fs-wire.ts';
import { OS_RELEASE } from '../../version.ts';
import { devFdStat, devReaddir, devResolveTarget, devStat, devSync, inDev } from '../js/js-dev.ts';
import { FDFLAGS, OFLAGS, RIGHTS } from '../wasi/wasi-abi.ts';
import { deviceOf } from '../wasi/wasi-fds.ts';
import type { WasiEntry } from '../wasi/wasi-files.ts';
import { wasiErrno } from '../wasi-errno.ts';
import type { EmContext } from './context.ts';
import { AT_FDCWD } from './cwd.ts';
import { EM, EmError, negated } from './errno.ts';
import {
  DIRENT_SIZE,
  type EmStat,
  putString,
  S_IFCHR,
  S_IFDIR,
  S_IFIFO,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  S_IFSOCK,
  writeDirent,
  writeStat,
  writeStatfs,
} from './layout.ts';

export const O_ACCMODE = 0o3;
export const O_WRONLY = 0o1;
export const O_RDWR = 0o2;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;
export const O_NONBLOCK = 0o4000;
export const O_DIRECTORY = 0o200000;
export const O_NOFOLLOW = 0o400000;
export const O_CLOEXEC = 0o2000000;
export const O_PATH = 0o10000000;

const AT_SYMLINK_NOFOLLOW = 0x100;
const AT_REMOVEDIR = 0x200;
const AT_SYMLINK_FOLLOW = 0x400;
const AT_EACCESS = 0x200;
const AT_EMPTY_PATH = 0x1000;

const UTIME_NOW = 0x3fffffff;
const UTIME_OMIT = 0x3ffffffe;

const FD_ALIAS =
  /^\/(?:dev\/(stdin|stdout|stderr)|dev\/fd\/(\d+)|proc\/(self|[1-9]\d*)\/fd\/(\d+))$/;
const STDIO: Readonly<Record<string, number>> = { stdin: 0, stdout: 1, stderr: 2 };

const DT_CHR = 2;
const DT_DIR = 4;
const DT_REG = 8;
const DT_LNK = 10;

const encoder = new TextEncoder();

interface Listing {
  names: string[];
  stats: Map<string, SyncFsBridgeStat | null>;
  path: string;
}

export interface FilesState {
  listings: WeakMap<object, { listing: Listing; pos: number }>;
  mounts?: Set<string>;
}

export function fdAlias(ctx: EmContext, path: string): number | undefined {
  const m = FD_ALIAS.exec(path);
  if (!m) return undefined;
  if (m[1]) return STDIO[m[1]];
  if (m[3] !== undefined && m[3] !== 'self' && Number(m[3]) !== ctx.pid) return undefined;
  return Number(m[2] ?? m[4]);
}

function credOf(ctx: EmContext): Cred {
  return ctx.call({ op: 'proc-cred' }) as Cred;
}

function typeOf(st: SyncFsBridgeStat): number {
  if (st.isSymbolicLink) return S_IFLNK;
  if (st.isDirectory) return S_IFDIR;
  if (st.isSocket) return S_IFSOCK;
  if (st.isFifo) return S_IFIFO;
  if (st.isFile) return S_IFREG;
  const own = (st.mode ?? 0) & S_IFMT;
  return own || S_IFREG;
}

const RDEV: Readonly<Record<string, number>> = {
  '/dev/null': 0x103,
  '/dev/zero': 0x105,
  '/dev/full': 0x107,
  '/dev/random': 0x4000,
  '/dev/urandom': 0x4100,
  '/dev/tty': 0x500,
  '/dev/ptmx': 0x502,
  '/dev/sealed': 0xafa,
  '/dev/clipboard': 0xafb,
  '/dev/embedder': 0xafc,
};

export function emStat(ctx: EmContext, path: string, st: SyncFsBridgeStat, size?: number): EmStat {
  const owners = ctx.host.o.fs.owners === true;
  const type = typeOf(st);
  const fallback = type === S_IFDIR || type === S_IFLNK ? 0o777 : 0o666;
  const perm = (st.mode ?? fallback) & 0o7777;
  const mode = type | (owners ? perm : perm || fallback);
  const bytes = type === S_IFDIR ? 4096 : (size ?? st.size);
  const mtimeMs = st.mtimeMs ?? 0;
  let uid = owners ? (st.uid ?? 0) : 0;
  let gid = owners ? (st.gid ?? 0) : 0;
  if (!ctx.init.owners) {
    const cred = credOf(ctx);
    uid = cred.euid;
    gid = cred.egid;
  }
  return {
    dev: st.dev ?? 1,
    ino: st.ino ?? inodeOf(path),
    mode,
    nlink: st.nlink ?? 1,
    uid,
    gid,
    rdev: type === S_IFCHR ? (RDEV[path] ?? 0) : 0,
    size: bytes,
    atimeMs: st.atimeMs ?? mtimeMs,
    mtimeMs,
    ctimeMs: st.ctimeMs ?? mtimeMs,
    blocks: Math.ceil(bytes / 4096) * 8,
  };
}

function devKernel(ctx: EmContext) {
  return { json: (req: Parameters<EmContext['call']>[0]) => ctx.call(req) };
}

function bridgeStat(ctx: EmContext, path: string, follow: boolean): SyncFsBridgeStat {
  const fs = ctx.host.o.fs;
  if (inDev(path)) {
    try {
      return devSync(devKernel(ctx), devStat(path, follow));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
  }
  ctx.host.fds.flushPath(path);
  return follow ? fs.stat(path) : fs.lstat(path);
}

function linkStat(target: string): SyncFsBridgeStat {
  return {
    isFile: false,
    isDirectory: false,
    isSymbolicLink: true,
    size: encoder.encode(target).length,
    mode: S_IFLNK | 0o777,
    mtimeMs: Date.now(),
  };
}

export function fdTarget(ctx: EmContext, fd: number): string {
  const e = ctx.host.fds.get(fd);
  if (e.type === 'file') return e.file.path;
  if (e.type === 'dir') return e.path;
  if (e.type === 'device') return `/dev/${e.device}`;
  const target = devSync(devKernel(ctx), devResolveTarget(`/dev/fd/${fd}`));
  return target ?? `pipe:[${fd}]`;
}

export function pathStat(ctx: EmContext, path: string, follow: boolean): EmStat {
  const alias = fdAlias(ctx, path);
  if (alias !== undefined) {
    if (follow) return fdStat(ctx, alias);
    const target = /^\/dev\/std/.test(path) ? '' : fdTarget(ctx, alias);
    if (/^\/dev\/std/.test(path)) return emStat(ctx, path, linkStat(`/proc/self/fd/${alias}`));
    return emStat(ctx, path, { ...linkStat(target), size: 0, mode: S_IFLNK | 0o700 });
  }
  if (procFdDir(ctx, path)) {
    return emStat(ctx, path, {
      isFile: false,
      isDirectory: true,
      size: 0,
      mode: S_IFDIR | 0o555,
      mtimeMs: Date.now(),
    });
  }
  return emStat(ctx, path, bridgeStat(ctx, path, follow));
}

function kernelFdStat(ctx: EmContext, fd: number, kind: string): EmStat {
  if (kind === 'file') {
    const st = ctx.call({ op: 'fd-vfs-stat', fd, full: true }) as {
      path?: string;
      size: number;
      stat?: SyncFsBridgeStat;
    };
    const path = st.path ?? `/proc/self/fd/${fd}`;
    const base = st.stat ?? { isFile: true, isDirectory: false, size: st.size };
    return emStat(ctx, path, base, st.size);
  }
  if (kind === 'tty') return emStat(ctx, `/dev/fd/${fd}`, devSync(devKernel(ctx), devFdStat(fd)));
  const type = kind === 'socket' ? S_IFSOCK : kind === 'stream' ? S_IFIFO : S_IFCHR;
  const now = Date.now();
  return emStat(ctx, `pipe:${fd}`, {
    isFile: false,
    isDirectory: false,
    ...(type === S_IFSOCK ? { isSocket: true } : {}),
    ...(type === S_IFIFO ? { isFifo: true } : {}),
    size: 0,
    mode: type | 0o600,
    mtimeMs: now,
  });
}

export function fdStat(ctx: EmContext, fd: number): EmStat {
  const { fds } = ctx.host;
  const e = fds.get(fd);
  if (e.type === 'dir') return emStat(ctx, e.path, bridgeStat(ctx, e.path, true));
  if (e.type === 'device') {
    return emStat(ctx, `/dev/${e.device}`, bridgeStat(ctx, `/dev/${e.device}`, true));
  }
  if (e.type === 'file') {
    const file = e.file;
    let st: SyncFsBridgeStat | undefined;
    try {
      file.buffer.flush();
      st = ctx.host.o.fs.stat(file.path);
    } catch {
      const handle = file.buffer.handle;
      st = handle === undefined ? undefined : ctx.host.o.fs.keptStat?.(handle);
    }
    const base = st ?? { isFile: true, isDirectory: false, size: 0, nlink: 0 };
    const orphan = file.buffer.isOrphan();
    return emStat(ctx, file.path, orphan ? { ...base, nlink: 0 } : base, file.size());
  }
  return kernelFdStat(ctx, fd, fds.kind(fd, e));
}

function accessFlags(ctx: EmContext, fd: number, e: WasiEntry): number {
  if (e.type === 'dir') return O_DIRECTORY;
  if (e.type === 'file') {
    const acc = e.file.writable ? (e.file.readable ? O_RDWR : O_WRONLY) : 0;
    return acc | (e.file.append ? O_APPEND : 0);
  }
  if (e.type === 'device')
    return e.access === 'read' ? 0 : e.access === 'write' ? O_WRONLY : O_RDWR;
  const access = ctx.sys.access?.(fd);
  const acc = access === 'read' ? 0 : access === 'write' ? O_WRONLY : O_RDWR;
  return acc | (e.append ? O_APPEND : 0) | (e.nonblock ? O_NONBLOCK : 0);
}

function rightsOf(flags: number): bigint {
  const acc = flags & O_ACCMODE;
  if (acc === O_WRONLY) return RIGHTS.ALL & ~RIGHTS.FD_READ;
  if (acc === O_RDWR) return RIGHTS.ALL;
  return RIGHTS.ALL & ~RIGHTS.FD_WRITE;
}

function oflagsOf(flags: number): number {
  return (
    (flags & O_CREAT ? OFLAGS.CREAT : 0) |
    (flags & O_DIRECTORY ? OFLAGS.DIRECTORY : 0) |
    (flags & O_EXCL ? OFLAGS.EXCL : 0) |
    (flags & O_TRUNC ? OFLAGS.TRUNC : 0)
  );
}

function fdflagsOf(flags: number): number {
  return (flags & O_APPEND ? FDFLAGS.APPEND : 0) | (flags & O_NONBLOCK ? FDFLAGS.NONBLOCK : 0);
}

function refusedCreation(ctx: EmContext, path: string): void {
  const cred = ctx.host.o.fs.owners ? credOf(ctx) : undefined;
  const refused = devCreation(path, cred);
  if (!refused) return;
  try {
    bridgeStat(ctx, path, false);
  } catch {
    throw new EmError(wasiErrno(refused));
  }
}

export function openPath(ctx: EmContext, path: string, flags: number, mode: number): number {
  const { fds } = ctx.host;
  if (flags & O_CREAT) refusedCreation(ctx, path);
  const alias = fdAlias(ctx, path);
  const target = alias !== undefined && alias > 2 ? `/dev/fd/${alias}` : path;
  if (alias !== undefined && alias > 2) fds.get(alias);
  if (procFdDir(ctx, path) || path === '/dev/fd') {
    if ((flags & O_ACCMODE) !== 0 || flags & (O_CREAT | O_TRUNC)) throw new EmError(EM.ISDIR);
    const fd = fds.preopenAt(path, '');
    if (flags & O_CLOEXEC) fds.setCloexec(fd, true);
    return fd;
  }
  const umask = ctx.host.umask();
  const created = flags & O_CREAT ? mode & 0o7777 & ~umask : undefined;
  const nofollow = (flags & O_NOFOLLOW) !== 0;
  if (deviceOf(target)) ctx.host.interrupted?.();
  const fd = fds.open(
    target,
    oflagsOf(flags),
    rightsOf(flags),
    fdflagsOf(flags),
    created,
    nofollow
  );
  if (flags & O_CLOEXEC) fds.setCloexec(fd, true);
  return fd;
}

function times(ctx: EmContext, ptr: number): [number | null, number | null] {
  const now = Date.now();
  if (!ptr) return [now, now];
  const v = ctx.mem.view();
  const one = (at: number): number | null => {
    const nsec = v.getInt32(at + 8, true);
    if (nsec === UTIME_NOW) return now;
    if (nsec === UTIME_OMIT) return null;
    const sec = v.getUint32(at, true) + v.getInt32(at + 4, true) * 4294967296;
    return sec * 1000 + nsec / 1e6;
  };
  return [one(ptr), one(ptr + 16)];
}

function touching(ctx: EmContext, ptr: number): boolean {
  if (!ptr) return true;
  const v = ctx.mem.view();
  const a = v.getInt32(ptr + 8, true);
  const m = v.getInt32(ptr + 24, true);
  return (a === UTIME_NOW || a === UTIME_OMIT) && (m === UTIME_NOW || m === UTIME_OMIT);
}

function setTimes(
  ctx: EmContext,
  path: string,
  atime: number | null,
  mtime: number | null,
  follow: boolean,
  now: boolean
): void {
  const fs = ctx.host.o.fs;
  ctx.host.fds.flushPath(path);
  let a = atime;
  let m = mtime;
  if (a === null || m === null) {
    const st = follow ? fs.stat(path) : fs.lstat(path);
    a ??= st.atimeMs ?? st.mtimeMs ?? Date.now();
    m ??= st.mtimeMs ?? Date.now();
  }
  (follow ? fs.utimes : fs.lutimes).call(fs, path, a, m, now);
}

const PROC_FD = /^\/proc\/(self|[1-9]\d*)\/fd$/;

function procFdDir(ctx: EmContext, path: string): boolean {
  const m = PROC_FD.exec(path);
  return m !== null && (m[1] === 'self' || Number(m[1]) === ctx.pid);
}

function fdNames(ctx: EmContext): string[] {
  const listed = ctx.call({ op: 'fd-list' }) as Array<{ fd: number }>;
  const fds: number[] = [];
  for (const entry of listed) fds.push(entry.fd);
  fds.sort((a, b) => a - b);
  const names: string[] = [];
  for (const fd of fds) names.push(String(fd));
  return names;
}

function listing(ctx: EmContext, path: string): Listing {
  if (procFdDir(ctx, path) || path === '/dev/fd') {
    const names = ['.', '..'];
    const stats = new Map<string, SyncFsBridgeStat | null>();
    for (const name of fdNames(ctx)) {
      names.push(name);
      stats.set(name, { ...linkStat(''), mode: S_IFLNK | 0o700 });
    }
    return { names, stats, path };
  }
  if (inDev(path) && path !== '/dev/shm' && !path.startsWith('/dev/shm/')) {
    const names = ['.', '..'];
    const stats = new Map<string, SyncFsBridgeStat | null>();
    const listed = devSync(devKernel(ctx), devReaddir(path));
    if (path === '/dev' && !listed.includes('fd')) listed.push('fd');
    listed.sort();
    for (const name of listed) {
      names.push(name);
      const child = childPath(path, name);
      try {
        stats.set(name, bridgeStat(ctx, child, false));
      } catch {
        stats.set(name, null);
      }
    }
    return { names, stats, path };
  }
  const listed = ctx.host.o.fs.readdirStat(path);
  const names = ['.', '..'];
  const stats = new Map<string, SyncFsBridgeStat | null>();
  for (const [name, st] of listed) {
    names.push(name);
    stats.set(name, st);
  }
  return { names, stats, path };
}

function direntType(st: SyncFsBridgeStat | null): number {
  if (!st) return DT_REG;
  if (st.isDirectory) return DT_DIR;
  if (st.isSymbolicLink) return DT_LNK;
  if (!st.isFile && ((st.mode ?? 0) & S_IFMT) === S_IFCHR) return DT_CHR;
  return DT_REG;
}

function childPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function dirOf(ctx: EmContext, fd: number): Extract<WasiEntry, { type: 'dir' }> {
  const e = ctx.host.fds.get(fd);
  if (e.type !== 'dir') throw new EmError(EM.NOTDIR);
  return e;
}

function getdents(ctx: EmContext, state: FilesState, fd: number, dirp: number, count: number) {
  const dir = dirOf(ctx, fd);
  let held = state.listings.get(dir);
  if (!held) {
    held = { listing: listing(ctx, dir.path), pos: 0 };
    state.listings.set(dir, held);
  }
  const { names, stats, path } = held.listing;
  const start = Math.floor(held.pos / DIRENT_SIZE);
  const end = Math.min(names.length, start + Math.floor(count / DIRENT_SIZE));
  let pos = 0;
  let idx = start;
  for (; idx < end; idx++) {
    const name = names[idx] as string;
    let ino: number;
    let type: number;
    if (name === '.' || name === '..') {
      const at = name === '.' ? path : parentOf(path);
      ino = inodeOf(at);
      type = DT_DIR;
      try {
        ino = ctx.host.o.fs.stat(at).ino ?? ino;
      } catch {}
    } else {
      const full = childPath(path, name);
      let st = stats.get(name) ?? null;
      if (st === null) {
        try {
          st = ctx.host.o.fs.lstat(full);
        } catch {
          st = null;
        }
      }
      ino = st?.ino ?? inodeOf(full);
      type = direntType(st);
    }
    writeDirent(ctx.mem, dirp + pos, ino, (idx + 1) * DIRENT_SIZE, type, name);
    pos += DIRENT_SIZE;
  }
  held.pos = idx * DIRENT_SIZE;
  return pos;
}

export function seekDir(state: FilesState, entry: object, offset: number, whence: number): number {
  const held = state.listings.get(entry);
  const base = whence === 1 ? (held?.pos ?? 0) : 0;
  const pos = base + offset;
  if (pos < 0) throw new EmError(EM.INVAL);
  if (pos === 0 && whence === 0) {
    state.listings.delete(entry);
    return 0;
  }
  if (held) held.pos = pos;
  return pos;
}

const UTS_FIELD = 65;

function hostnameOf(ctx: EmContext): string {
  return initHostname(ctx.init);
}

function chown(ctx: EmContext, path: string, uid: number, gid: number, follow: boolean): void {
  const fs = ctx.host.o.fs;
  if (!fs.chown) throw new EmError(EM.NOSYS);
  const id = (v: number) => (v >>> 0 === 0xffffffff ? undefined : v >>> 0);
  fs.chown.call(fs, path, id(uid), id(gid), follow);
}

function chmodPath(ctx: EmContext, path: string, mode: number, follow: boolean): void {
  const fs = ctx.host.o.fs;
  const alias = fdAlias(ctx, path);
  if (alias !== undefined && follow) {
    chmodFd(ctx, alias, mode);
    return;
  }
  if (!follow && fs.lstat(path).isSymbolicLink) throw new EmError(EM.NOTSUP);
  fs.chmod(follow ? physicalPath(fs, path) : path, mode & 0o7777);
}

function chmodFd(ctx: EmContext, fd: number, mode: number): void {
  const e = ctx.host.fds.get(fd);
  if (e.type === 'kernel' && ctx.host.fds.kind(fd, e) === 'file') {
    ctx.sys.fdChmod?.(fd, mode & 0o7777);
    return;
  }
  if (e.type === 'dir') return void ctx.host.o.fs.chmod(e.path, mode & 0o7777);
  if (e.type === 'file') return void ctx.host.o.fs.chmod(e.file.path, mode & 0o7777);
  throw new EmError(EM.PERM);
}

function access(ctx: EmContext, path: string, amode: number, flags: number): void {
  if (amode & ~7) throw new EmError(EM.INVAL);
  const fs = ctx.host.o.fs;
  const follow = (flags & AT_SYMLINK_NOFOLLOW) === 0;
  const alias = fdAlias(ctx, path);
  if (alias !== undefined) {
    ctx.host.fds.get(alias);
    return;
  }
  const st = bridgeStat(ctx, path, follow);
  if (amode & 2 && st.readonly) throw new EmError(69);
  if (!fs.owners || !fs.access || inDev(path)) return;
  const kind = flags & AT_EACCESS ? 'eaccess' : 'access';
  fs.access(path, amode & 7, kind, !follow);
}

function unlinkPath(ctx: EmContext, path: string): void {
  const fs = ctx.host.o.fs;
  const { fds } = ctx.host;
  const st = fs.lstat(path);
  if (st.isDirectory) throw new EmError(EM.ISDIR);
  const linked = (st.nlink ?? 1) > 1 ? st : undefined;
  fds.unlinking(path, linked);
  fs.unlink(path);
  fds.unlinked(path, linked);
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

function mountOf(ctx: EmContext, state: FilesState, dir: string): string {
  if (dir === '/dev/shm' || dir.startsWith('/dev/shm/')) return '/dev/shm';
  if (dir === '/') return '/';
  const top = `/${dir.split('/')[1]}`;
  return mountPoints(ctx, state).has(top) ? top : '/';
}

function mountPoints(ctx: EmContext, state: FilesState): Set<string> {
  if (state.mounts) return state.mounts;
  const fs = ctx.host.o.fs;
  const out = new Set<string>(['/dev', '/proc']);
  let names: string[] = [];
  try {
    names = fs.readdir('/');
  } catch {}
  for (const name of [...names, 'usr', 'bin']) {
    if (!name || name.includes('/') || name === 'dev' || name === 'proc') continue;
    try {
      if (fs.stat(`/${name}`).isDirectory) out.add(`/${name}`);
    } catch {}
  }
  try {
    if (fs.stat('/dev/shm').isDirectory) out.add('/dev/shm');
  } catch {}
  state.mounts = out;
  return out;
}

function removeDir(ctx: EmContext, state: FilesState, path: string): void {
  if (path === '/' || mountPoints(ctx, state).has(path)) {
    ctx.host.o.fs.lstat(path);
    throw new EmError(EM.BUSY);
  }
  ctx.host.o.fs.rmdir(path);
}

function renamePath(ctx: EmContext, state: FilesState, from: string, to: string): void {
  const fs = ctx.host.o.fs;
  const { fds } = ctx.host;
  const points = mountPoints(ctx, state);
  if (points.has(from)) {
    fs.lstat(from);
    throw new EmError(EM.XDEV);
  }
  if (points.has(to)) {
    fs.lstat(from);
    throw new EmError(EM.BUSY);
  }
  if (mountOf(ctx, state, parentOf(from)) !== mountOf(ctx, state, parentOf(to))) {
    fs.lstat(from);
    throw new EmError(EM.XDEV);
  }
  fds.flushPath(from);
  let replaced: SyncFsBridgeStat | undefined;
  if (fds.holdsUnder(to)) {
    try {
      const st = fs.lstat(to);
      replaced = (st.nlink ?? 1) > 1 ? st : undefined;
    } catch {}
  }
  if (replaced === undefined) fds.replacing(to);
  const seq = fs.rename(from, to);
  fds.renamed(from, to, replaced);
  fds.ownRename(typeof seq === 'number' ? seq : undefined);
}

function linkPath(ctx: EmContext, from: string, to: string, follow: boolean): void {
  const fs = ctx.host.o.fs;
  const { fds } = ctx.host;
  const source = follow ? physicalPath(fs, from) : from;
  fds.flushPath(from);
  if (source !== from) fds.flushPath(source);
  try {
    fs.link(from, to, follow);
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EPERM' || linkable(ctx, source)) throw err;
    throw new EmError(EM.MLINK);
  }
  fds.linked(from, to);
  if (source !== from) fds.linked(source, to);
}

function linkable(ctx: EmContext, path: string): boolean {
  try {
    return ctx.host.o.fs.lstat(path).linkable === true;
  } catch {
    return false;
  }
}

function truncateFd(ctx: EmContext, fd: number, size: number): void {
  const e = ctx.host.fds.get(fd);
  if (e.type === 'file') {
    if (!e.file.writable) throw new EmError(EM.INVAL);
    e.file.buffer.truncate(size);
    return;
  }
  if (e.type === 'kernel' && ctx.host.fds.kind(fd, e) === 'file') {
    ctx.call({ op: 'fd-resize', fd, size });
    ctx.host.o.fs.touched?.(e.path, e.ino);
    return;
  }
  throw new EmError(EM.INVAL);
}

function syncFd(ctx: EmContext, fd: number): void {
  const e = ctx.host.fds.get(fd);
  if (e.type === 'file') ctx.host.fds.synced(e.file);
  else if (e.type === 'kernel' && ctx.host.fds.kind(fd, e) === 'file') ctx.sys.flush(fd);
}

function readlink(ctx: EmContext, path: string): string {
  const alias = fdAlias(ctx, path);
  if (alias !== undefined) {
    if (/^\/dev\/(stdin|stdout|stderr)$/.test(path)) return `/proc/self/fd/${alias}`;
    return fdTarget(ctx, alias);
  }
  return ctx.host.o.fs.readlink(path);
}

export function fileImports(ctx: EmContext, state: FilesState): Record<string, unknown> {
  const { mem } = ctx;
  const str = (ptr: number) => mem.cString(ptr);
  const at = (dirfd: number, ptr: number, empty = false) => ctx.cwd.resolve(dirfd, str(ptr), empty);
  const fds = () => ctx.host.fds;
  return {
    __syscall_chdir: negated((p: number) => ctx.cwd.chdir(at(AT_FDCWD, p))),
    __syscall_fchdir: negated((fd: number) => ctx.cwd.chdir(dirOf(ctx, fd).path)),
    __syscall_getcwd: negated((buf: number, size: number) => {
      if (size === 0) return -EM.INVAL;
      if (ctx.cwd.gone()) return -EM.NOENT;
      const cwd = ctx.cwd.path;
      const n = encoder.encode(cwd).length + 1;
      if (size < n) return -EM.RANGE;
      putString(mem, buf, cwd, size);
      return n;
    }),
    __syscall_chmod: negated((p: number, mode: number) =>
      chmodPath(ctx, at(AT_FDCWD, p), mode, true)
    ),
    __syscall_fchmod: negated((fd: number, mode: number) => chmodFd(ctx, fd, mode)),
    __syscall_fchmodat2: negated((dirfd: number, p: number, mode: number, flags: number) =>
      chmodPath(ctx, at(dirfd, p), mode, (flags & AT_SYMLINK_NOFOLLOW) === 0)
    ),
    __syscall_fchown32: negated((fd: number, uid: number, gid: number) => {
      const e = fds().get(fd);
      if (e.type === 'kernel' && fds().kind(fd, e) === 'file') {
        const id = (v: number) => (v >>> 0 === 0xffffffff ? undefined : v >>> 0);
        ctx.sys.fdChown?.(fd, id(uid), id(gid));
        return;
      }
      chown(ctx, fdTarget(ctx, fd), uid, gid, true);
    }),
    __syscall_fchownat: negated(
      (dirfd: number, p: number, uid: number, gid: number, flags: number) =>
        chown(
          ctx,
          at(dirfd, p, (flags & AT_EMPTY_PATH) !== 0),
          uid,
          gid,
          !(flags & AT_SYMLINK_NOFOLLOW)
        )
    ),
    __syscall_faccessat: negated((dirfd: number, p: number, amode: number, flags: number) =>
      access(ctx, at(dirfd, p), amode, flags)
    ),
    __syscall_fadvise64: () => 0,
    __syscall_fdatasync: negated((fd: number) => syncFd(ctx, fd)),
    __syscall_fstat64: negated((fd: number, buf: number) => writeStat(mem, buf, fdStat(ctx, fd))),
    __syscall_stat64: negated((p: number, buf: number) =>
      writeStat(mem, buf, pathStat(ctx, at(AT_FDCWD, p), true))
    ),
    __syscall_lstat64: negated((p: number, buf: number) =>
      writeStat(mem, buf, pathStat(ctx, at(AT_FDCWD, p), false))
    ),
    __syscall_newfstatat: negated((dirfd: number, p: number, buf: number, flags: number) => {
      const raw = str(p);
      if (raw === '' && flags & AT_EMPTY_PATH && dirfd !== AT_FDCWD) {
        return writeStat(mem, buf, fdStat(ctx, dirfd));
      }
      const path = ctx.cwd.resolve(dirfd, raw, (flags & AT_EMPTY_PATH) !== 0);
      writeStat(mem, buf, pathStat(ctx, path, (flags & AT_SYMLINK_NOFOLLOW) === 0));
    }),
    __syscall_statfs64: negated((p: number, _size: number, buf: number) => {
      at(AT_FDCWD, p);
      const usage = ctx.host.o.fs.statfs?.(at(AT_FDCWD, p)) ?? null;
      const blocks = usage ? Math.ceil(usage.quota / 4096) : 1000000;
      const used = usage ? Math.ceil(usage.usage / 4096) : 500000;
      writeStatfs(mem, buf, {
        bsize: 4096,
        blocks,
        bfree: Math.max(0, blocks - used),
        bavail: Math.max(0, blocks - used),
        files: 1000000,
        ffree: 500000,
        fsid: 42,
        flags: 2,
        namelen: 255,
      });
    }),
    __syscall_ftruncate64: negated((fd: number, length: bigint) => {
      const size = Number(length);
      if (!Number.isSafeInteger(size)) return -EM.OVERFLOW;
      if (size < 0) return -EM.INVAL;
      truncateFd(ctx, fd, size);
    }),
    ...moreFileImports(ctx, state),
  };
}

function moreFileImports(ctx: EmContext, state: FilesState): Record<string, unknown> {
  const { mem } = ctx;
  const str = (ptr: number) => mem.cString(ptr);
  const at = (dirfd: number, ptr: number, empty = false) => ctx.cwd.resolve(dirfd, str(ptr), empty);
  return {
    __syscall_getdents64: negated((fd: number, dirp: number, count: number) =>
      getdents(ctx, state, fd, dirp, count)
    ),
    __syscall_mkdirat: negated((dirfd: number, p: number, mode: number) => {
      const path = at(dirfd, p);
      refusedCreation(ctx, path);
      const fs = ctx.host.o.fs;
      if (fs.exists(path)) throw new EmError(EM.EXIST);
      const perm = mode & 0o7777 & ~ctx.host.umask();
      fs.mkdir(path, fs.owners ? perm : undefined);
      if (!fs.owners && perm !== 0o755) fs.chmod(path, perm);
    }),
    __syscall_mknodat: negated((dirfd: number, p: number, mode: number) => {
      const path = at(dirfd, p);
      const type = mode & S_IFMT;
      if (
        type !== S_IFREG &&
        type !== S_IFCHR &&
        type !== 0o060000 &&
        type !== S_IFIFO &&
        type !== S_IFSOCK
      ) {
        return -EM.INVAL;
      }
      refusedCreation(ctx, path);
      const fs = ctx.host.o.fs;
      const perm = mode & 0o7777 & ~ctx.host.umask();
      if (type === S_IFIFO && fs.mkfifo) return void fs.mkfifo(path, perm);
      if (type === S_IFREG) {
        if (fs.exists(path)) throw new EmError(EM.EXIST);
        if (fs.create) fs.create(path, fs.owners ? perm : undefined);
        else fs.writeFile(path, new Uint8Array(0));
        return;
      }
      throw new EmError(EM.PERM);
    }),
    __syscall_openat: negated((dirfd: number, p: number, flags: number, varargs: number) => {
      const mode = varargs ? mem.view().getInt32(varargs, true) : 0;
      return openPath(ctx, at(dirfd, p), flags, mode);
    }),
    __syscall_readlinkat: negated((dirfd: number, p: number, buf: number, bufsize: number) => {
      const path = at(dirfd, p);
      if (bufsize <= 0) return -EM.INVAL;
      const target = encoder.encode(readlink(ctx, path));
      const n = Math.min(bufsize, target.length);
      mem.bytes(buf, n).set(target.subarray(0, n));
      return n;
    }),
    __syscall_renameat: negated((od: number, op: number, nd: number, np: number) =>
      renamePath(ctx, state, at(od, op), at(nd, np))
    ),
    __syscall_rmdir: negated((p: number) => removeDir(ctx, state, at(AT_FDCWD, p))),
    __syscall_symlinkat: negated((target: number, dirfd: number, p: number) => {
      const path = at(dirfd, p);
      refusedCreation(ctx, path);
      ctx.host.o.fs.symlink(str(target), path);
    }),
    __syscall_linkat: negated((od: number, op: number, nd: number, np: number, flags: number) =>
      linkPath(ctx, at(od, op), at(nd, np), (flags & AT_SYMLINK_FOLLOW) !== 0)
    ),
    __syscall_unlinkat: negated((dirfd: number, p: number, flags: number) => {
      const path = at(dirfd, p);
      if (flags === 0) return void unlinkPath(ctx, path);
      if (flags === AT_REMOVEDIR) return void removeDir(ctx, state, path);
      return -EM.INVAL;
    }),
    __syscall_utimensat: negated((dirfd: number, p: number, ptr: number, flags: number) => {
      const path = at(dirfd, p, true);
      const [atime, mtime] = times(ctx, ptr);
      if ((mtime ?? atime) === null) return;
      setTimes(ctx, path, atime, mtime, (flags & AT_SYMLINK_NOFOLLOW) === 0, touching(ctx, ptr));
    }),
    __syscall_umask: (mask: number) => ctx.host.umask(mask & 0o777),
    __syscall_uname: negated((buf: number) => {
      if (!buf) return -EM.FAULT;
      const fields = [
        'Linux',
        hostnameOf(ctx),
        OS_RELEASE,
        '#1 SMP PREEMPT_DYNAMIC',
        'wasm32',
        '(none)',
      ];
      mem.bytes(buf, UTS_FIELD * fields.length).fill(0);
      for (let i = 0; i < fields.length; i++) {
        putString(mem, buf + i * UTS_FIELD, fields[i] as string, UTS_FIELD);
      }
    }),
  };
}

export function fdFlags(ctx: EmContext, fd: number): number {
  return accessFlags(ctx, fd, ctx.host.fds.get(fd));
}
