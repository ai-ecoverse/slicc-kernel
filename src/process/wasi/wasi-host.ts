import { inDevTree } from '../../fs/dev-removal.ts';
import { physicalLeaf, physicalPath } from '../../fs/physical-path.ts';
import { localCpuNanos } from '../../kernel/cpu-clock.ts';
import { type Cred, type CredChange, MAX_GROUPS } from '../../kernel/cred.ts';
import type { DeviceMeta, KernelFdKind } from '../../kernel/fd-table.ts';
import type { HeldCwd } from '../../kernel/held-cwd.ts';
import type { FdInfo } from '../../kernel/process.ts';
import { KERNEL_SIGINFO, SIG, type SigInfo } from '../../kernel/signals.ts';
import type { SyncFsBridgeStat, SyncFsPosixBridge } from '../../realm/sync-fs-wire.ts';
import { devFdStat, devStat, devSync, inDev } from '../js/js-dev.ts';
import type { LockHeld } from '../process-locks.ts';
import { type LockedFile, type LockHost, lockImports } from './slicc-lock.ts';
import { semImports } from './slicc-sem.ts';
import {
  CLOCK,
  E,
  FDFLAGS,
  FILETYPE,
  FSTFLAGS,
  LOOKUP_SYMLINK_FOLLOW,
  PREOPENTYPE_DIR,
  RIFLAGS,
  RIGHTS,
  SDFLAGS,
  SIZE,
  WASI_SIGNAL_TO_POSIX,
  WHENCE,
  wasiErrnoOf,
} from './wasi-abi.ts';
import { CredCache, UmaskCache, UNGATED } from './wasi-cred.ts';
import {
  CLIPBOARD_PATH,
  deviceOf,
  SEALED_PATH,
  WasiFds,
  type WasiForkFd,
  type WasiKernel,
} from './wasi-fds.ts';
import {
  type DirListing,
  type LocalFile,
  normalize,
  pathInode,
  resolveUnder,
  type WasiEntry,
  WasiError,
} from './wasi-files.ts';
import { WasiMemory } from './wasi-memory.ts';
import { pollOneoff } from './wasi-poll.ts';
import { libcBits, SIG_SETMASK, SIG_UNBLOCK, type WasiSigmask } from './wasi-sigmask.ts';
import type { WasiSignals } from './wasi-signals.ts';
import { sliccTty } from './wasi-termios.ts';
import { wasixEpollImports } from './wasix-epoll.ts';
import type { ThreadEntry } from './wasix-fork.ts';
import { datagramCalls } from './wasix-sockets.ts';

export class WasiExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export interface WasiHostOptions {
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  pid: number;

  ppid?: number;
  parent?: () => number;
  kernel: WasiKernel;

  fs: SyncFsPosixBridge & { invalidate?(): void; touched?(path?: string, ino?: number): void };

  inherited?: ReadonlyArray<{
    fd: number;
    kind?: KernelFdKind;
    flags?: number;
    device?: DeviceMeta;
  }>;

  shared?: Int32Array;

  credGen?: Int32Array;

  forked?: { fds: readonly WasiForkFd[]; cloexec: readonly number[] };

  preopenRoot?: boolean;

  bare?: boolean;

  held?: HeldCwd;
}

export type WasiFunction = (...args: never[]) => number | undefined;

type EpollWait = (
  epfd: number,
  events: number,
  max: number,
  timeout: bigint,
  nevents: number
) => number | undefined;

const IDS = ['ruid', 'euid', 'suid', 'rgid', 'egid', 'sgid'] as const;
const NS_PER_MS = 1_000_000n;
const AT_SYMLINK_NOFOLLOW = 1;
const AT_FDCWD = -2;
const COPY_EXCL = 1;
const COPY_MODE = 2;
const AT_EACCESS = 2;

const ROOT_IDS = Object.freeze({ uid: 0, gid: 0 });
const GONE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

function idOf(value: number): number | undefined {
  return value >>> 0 === 0xffffffff ? undefined : value >>> 0;
}
const S_IFIFO = 0o010000;
const S_IFLNK = 0o120000;
const DEFAULT_UMASK = 0o022;

const MONOTONIC_BASE = BigInt(Math.round(performance.timeOrigin)) * NS_PER_MS;

const MAX_READ = 1024 * 1024;
const SIGINFO_BYTES = 24;

const FD_ALIAS =
  /^\/(?:dev\/(stdin|stdout|stderr)|dev\/fd\/(\d+)|proc\/(self|[1-9]\d*)\/fd\/(\d+))$/;
const STDIO_FDS: Readonly<Record<string, number>> = { stdin: 0, stdout: 1, stderr: 2 };

interface FdAlias {
  fd: number;
  stdio: boolean;
}
const SIGPIPE_EXIT = 128 + SIG.PIPE;

const SIG_IGN = 1;

interface Positional {
  pread(max: number, at: number): Uint8Array;
  pwrite(bytes: Uint8Array, at: number): number;
  size(): number;
  truncate(size: number): void;
}

interface Filestat {
  filetype: number;
  size: bigint;
  ino: bigint;
  nlink?: bigint;
  mtimeNs: bigint;
}

function linkedOf(st: SyncFsBridgeStat): SyncFsBridgeStat | undefined {
  return (st.nlink ?? 1) > 1 ? st : undefined;
}

function linkedElsewhere(
  fs: Pick<SyncFsPosixBridge, 'lstat'>,
  path: string
): SyncFsBridgeStat | undefined {
  try {
    return linkedOf(fs.lstat(path));
  } catch {
    return undefined;
  }
}

function filetypeOf(s: SyncFsBridgeStat | null | undefined): number {
  if (!s) return FILETYPE.UNKNOWN;
  if (s.isSymbolicLink) return FILETYPE.SYMBOLIC_LINK;
  if (s.isDirectory) return FILETYPE.DIRECTORY;
  if (s.isSocket) return FILETYPE.SOCKET_STREAM;
  if (((s.mode ?? 0) & 0o170000) === 0o020000) return FILETYPE.CHARACTER_DEVICE;
  return s.isFile ? FILETYPE.REGULAR_FILE : FILETYPE.UNKNOWN;
}

function filestatOf(path: string, s: SyncFsBridgeStat): Filestat {
  return {
    filetype: filetypeOf(s),
    size: BigInt(s.size),
    ino: s.ino !== undefined ? BigInt(s.ino) : pathInode(path),
    ...(s.nlink !== undefined ? { nlink: BigInt(s.nlink) } : {}),
    mtimeNs: BigInt(Math.round(s.mtimeMs ?? 0)) * NS_PER_MS,
  };
}

const SEALED_MODE = 0o20666;
const DEVICE_MODE = 0o20666;

function kernelDev(path: string): boolean {
  return inDev(path) && path !== SEALED_PATH && path !== CLIPBOARD_PATH;
}

function kernelFiletype(kind: string): { filetype: number; seeks: boolean } {
  switch (kind) {
    case 'tty':
    case 'sealed':
    case 'clipboard':
      return { filetype: FILETYPE.CHARACTER_DEVICE, seeks: false };
    case 'device':
      return { filetype: FILETYPE.CHARACTER_DEVICE, seeks: true };
    case 'socket':
      return { filetype: FILETYPE.SOCKET_STREAM, seeks: false };
    case 'dgram':
      return { filetype: FILETYPE.SOCKET_DGRAM, seeks: false };
    case 'file':
      return { filetype: FILETYPE.REGULAR_FILE, seeks: true };
    default:
      return { filetype: FILETYPE.UNKNOWN, seeks: false };
  }
}

export class WasiHost {
  readonly mem = new WasiMemory();
  readonly fds: WasiFds;
  private readonly creds: CredCache;
  private readonly umasks: UmaskCache;
  private readonly started = performance.now();
  private cache: Record<string, WasiFunction> | undefined;

  private readonly startCwd: string;

  interruptWakes = false;

  strictEpoll = false;

  cwdFd = false;

  entered = false;

  enteredSignals = 0;

  raisedOnEntry: (() => number) | undefined;

  onRaise: ((sig: number) => boolean) | undefined;

  muted: ((fd: number, data: Uint8Array) => boolean) | undefined;

  signals: WasiSignals | undefined;

  sigmask: WasiSigmask | undefined;

  tid = 1;

  linkedTls: (() => Array<[number, number]>) | undefined;

  threadEntry: ThreadEntry | undefined;

  linkedModules: (() => Record<string, WebAssembly.Module>) | undefined;

  interrupted: (() => boolean) | undefined;

  quietly: <T>(fn: () => T) => T = UNGATED.quiet;

  deliverDue: () => void = UNGATED.deliver;

  private readonly listening: number[];

  readonly o: WasiHostOptions;
  constructor(o: WasiHostOptions) {
    const { kernel } = o;
    const call: WasiKernel['call'] = (req) => {
      if (req.op !== 'fd-promote') this.fds.flushEarly();
      return kernel.call(req);
    };
    const sys = new Proxy(kernel.sys, {
      get: (target, name) => {
        const member = Reflect.get(target, name);
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          this.fds.flushEarly();
          return member.apply(target, args);
        };
      },
    });
    this.o = { ...o, kernel: { sys, call } };
    this.startCwd = o.cwd;
    this.fds = new WasiFds(this.o.kernel, o.fs);
    if (o.held) this.fds.held = o.held;
    this.creds = new CredCache(
      () => this.o.kernel.call({ op: 'proc-cred' }) as Cred,
      o.credGen ?? o.shared
    );
    this.umasks = new UmaskCache(
      (mask) =>
        this.o.kernel.call(
          mask === undefined ? { op: 'proc-umask' } : { op: 'proc-umask', mask }
        ) as number,
      o.credGen ?? o.shared,
      { quiet: (fn) => this.quietly(fn), deliver: () => this.deliverDue() }
    );
    if (o.shared) this.fds.share(o.shared, true);
    else if (o.forked) this.fds.restore(o.forked.fds, o.forked.cloexec);
    else if (!o.bare) this.fds.setup(o.cwd, o.inherited ?? [], o.preopenRoot === true);
    this.listening = o.shared ? [] : this.fds.sockets();
  }

  private fromCwd(raw: string): string {
    return this.fds.cwd() === undefined
      ? this.fds.resolve(3, `${this.cwd}/${raw}`)
      : this.fds.resolve(3, raw);
  }

  get cwd(): string {
    return this.fds.cwd() ?? this.startCwd;
  }

  umask(mask?: number): number {
    return mask === undefined ? this.umasks.get() : this.umasks.set(mask);
  }

  private copyImport(): WasiFunction {
    const { mem, fds } = this;
    const named = (dirfd: number, p: number, l: number): string => {
      const raw = mem.string(p, l);
      if (raw === '') throw new WasiError('ENOENT');
      if (raw.startsWith('/')) return fds.resolve(3, raw);
      return dirfd === AT_FDCWD ? this.fromCwd(raw) : fds.resolve(dirfd, raw);
    };
    return (...args: number[]) => {
      const [srcDirfd, sp, sl, dstDirfd, dp, dl, mode, flags] = args as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      if (!this.o.fs.copy) return E.NOSYS;
      if ((flags & ~(COPY_EXCL | COPY_MODE)) !== 0) throw new WasiError('EINVAL');
      const from = named(srcDirfd, sp, sl);
      const to = named(dstDirfd, dp, dl);
      const bits = flags & COPY_MODE ? (this.o.fs.stat(from).mode ?? 0) : mode;
      this.copyFile(from, to, bits, (flags & COPY_EXCL) !== 0);
      return E.SUCCESS;
    };
  }

  copyFile(from: string, to: string, mode: number, exclusive: boolean): void {
    const { copy } = this.o.fs;
    if (!copy) throw new WasiError('ENOSYS');
    this.fds.flushPath(from);
    copy.call(this.o.fs, from, to, mode & 0o7777 & ~this.umasks.get(), exclusive);
  }

  private created(path: string, mode: number): void {
    const umask = this.umasks.get();
    if (umask !== DEFAULT_UMASK) this.o.fs.chmod(path, mode & ~umask);
  }

  sliccTtyImports(): Record<string, WasiFunction> {
    return wrap(sliccTty(this.mem, this.fds, this.o.kernel, () => this.interrupted?.()));
  }

  sliccFsImports(): Record<string, WasiFunction> {
    const { mem, fds } = this;
    const at = (dirfd: number, p: number, l: number) => fds.resolve(dirfd, mem.string(p, l));
    const pathOf = (fd: number): string => {
      const e = fds.get(fd);
      if (e.type === 'dir') return e.path;
      if (e.type === 'file') return e.file.path;
      const path =
        e.type === 'kernel' && fds.kind(fd, e) === 'file' ? this.kernelStat(fd).path : undefined;
      if (path === undefined) throw new WasiError('EBADF');
      return path;
    };
    const target = (path: string, flags: number): string => {
      if (flags & AT_SYMLINK_NOFOLLOW && this.o.fs.lstat(path).isSymbolicLink) {
        throw new WasiError('ENOTSUP');
      }
      return path;
    };
    const modeOf = (st: { mode?: number }) => (st.mode ?? 0) & 0o7777;
    const chown = (path: string, uid: number, gid: number, follow: boolean, handle?: number) => {
      const { chown: own } = this.o.fs;
      if (!own) throw new WasiError('ENOSYS');
      own.call(this.o.fs, path, idOf(uid), idOf(gid), follow, handle);
    };
    const caller = (): [number, number] => {
      const cred = this.creds.get();
      return [cred.euid, cred.egid];
    };
    const owner = (st: { uid?: number; gid?: number } | undefined, out: number): void => {
      const [uid, gid] = st?.uid === undefined ? caller() : [st.uid, st.gid as number];
      const view = mem.view();
      view.getUint32(out + 4, true);
      view.setUint32(out, uid, true);
      view.setUint32(out + 4, gid, true);
    };
    const dev = {
      json: (req: Parameters<WasiHost['o']['kernel']['call']>[0]) => this.o.kernel.call(req),
    };
    const fdOwned = (fd: number): { uid?: number; gid?: number } | undefined => {
      const e = fds.get(fd);
      if (e.type === 'device') return ROOT_IDS;
      const kind = e.type === 'kernel' ? fds.kind(fd, e) : 'file';
      if (kind === 'sealed' || kind === 'clipboard') return ROOT_IDS;
      if (kind === 'tty') return devSync(dev, devFdStat(fd));
      if (kind !== 'file') return undefined;
      try {
        return this.o.fs.stat(pathOf(fd));
      } catch (err) {
        if (!GONE.has((err as { code?: unknown })?.code as string)) throw err;
        return undefined;
      }
    };
    const fdMode = (fd: number): number => {
      const e = fds.get(fd);
      if (e.type === 'device') return DEVICE_MODE;
      const kind = e.type === 'kernel' ? fds.kind(fd, e) : undefined;
      if (kind === 'stream') return S_IFIFO | 0o600;
      if (kind === 'sealed' || kind === 'clipboard') return SEALED_MODE;
      if (kind !== undefined && kind !== 'file')
        return devSync(dev, devFdStat(fd)).mode ?? DEVICE_MODE;
      return modeOf(this.o.fs.stat(pathOf(fd)));
    };
    const pathOwned = (
      path: string,
      follow: boolean
    ): { uid?: number; gid?: number } | undefined => {
      const alias = this.fdAlias(path);
      if (alias && !follow) return alias.stdio ? ROOT_IDS : undefined;
      if (alias) {
        this.openFd(alias.fd);
        return fdOwned(alias.fd);
      }
      if (this.synthetic(path)) return ROOT_IDS;
      if (kernelDev(path)) return devSync(dev, devStat(path, follow));
      return this.viaDev(path, follow, () => this.statOf(path, follow), pathOwned);
    };
    const pathMode = (path: string, follow: boolean): number => {
      const alias = this.fdAlias(path);
      if (alias && !follow) {
        this.fdTarget(alias);
        return S_IFLNK | 0o777;
      }
      if (alias) {
        this.openFd(alias.fd);
        return fdMode(alias.fd);
      }
      if (this.synthetic(path) && deviceOf(path) === undefined) return SEALED_MODE;
      if (kernelDev(path)) return devSync(dev, devStat(path, follow)).mode ?? DEVICE_MODE;
      const fileMode = (st: SyncFsBridgeStat) => (st.isFifo ? S_IFIFO : 0) | modeOf(st);
      return this.viaDev(path, follow, () => fileMode(this.statOf(path, follow)), pathMode);
    };
    return wrap({
      fd_chown: (fd: number, uid: number, gid: number) => {
        const e = fds.get(fd);
        const handle = e.type === 'file' ? e.file.buffer.handle : undefined;
        void chown(pathOf(fd), uid, gid, true, handle);
      },
      path_chown: (dirfd: number, p: number, l: number, uid: number, gid: number, flags: number) =>
        void chown(at(dirfd, p, l), uid, gid, (flags & AT_SYMLINK_NOFOLLOW) === 0),
      fd_owner: (fd: number, out: number) => {
        if (!this.o.fs.owners) throw new WasiError('ENOTSUP');
        owner(fdOwned(fd), out);
      },
      fd_filestat_owner: (fd: number, statOut: number, out: number) => {
        if (!this.o.fs.owners) throw new WasiError('ENOTSUP');
        this.writeFilestat(statOut, this.fdFilestat(fd));
        owner(fdOwned(fd), out);
      },
      path_filestat_owner: (
        dirfd: number,
        lookup: number,
        p: number,
        l: number,
        statOut: number,
        out: number
      ) => {
        const path = at(dirfd, p, l);
        if (!this.o.fs.owners) throw new WasiError('ENOTSUP');
        this.writeFilestat(statOut, this.pathFilestat(path, lookup));
        owner(pathOwned(path, (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0), out);
      },
      path_owner: (dirfd: number, p: number, l: number, flags: number, out: number) => {
        const path = at(dirfd, p, l);
        if (!this.o.fs.owners) throw new WasiError('ENOTSUP');
        owner(pathOwned(path, (flags & AT_SYMLINK_NOFOLLOW) === 0), out);
      },
      path_access: (dirfd: number, p: number, l: number, amode: number, flags: number) => {
        const path = at(dirfd, p, l);
        const nofollow = (flags & AT_SYMLINK_NOFOLLOW) !== 0;
        if (this.synthetic(path)) {
          if (this.o.fs.owners && amode & 1) throw new WasiError('EACCES');
          return;
        }
        const st = pathOwned(path, !nofollow);
        if (amode & 2 && (st as { readonly?: boolean }).readonly) throw new WasiError('EROFS');
        if (!this.o.fs.owners) return;
        const kind = flags & AT_EACCESS ? 'eaccess' : 'access';
        this.o.fs.access?.(path, amode & 7, kind, nofollow);
      },
      fd_chmod: (fd: number, mode: number) => void this.o.fs.chmod(pathOf(fd), mode & 0o7777),
      path_chmod: (dirfd: number, p: number, l: number, mode: number, flags: number) =>
        void this.o.fs.chmod(target(at(dirfd, p, l), flags), mode & 0o7777),
      path_mkfifo: (dirfd: number, p: number, l: number, mode: number) => {
        const { mkfifo } = this.o.fs;
        if (!mkfifo) return E.NOSYS;
        const raw = mem.string(p, l);
        if (raw === '') throw new WasiError('ENOENT');
        const path =
          dirfd === AT_FDCWD && !raw.startsWith('/') ? this.fromCwd(raw) : at(dirfd, p, l);
        const umask = this.umasks.get();
        const want = mode & 0o7777 & ~umask;
        mkfifo.call(this.o.fs, path, want);
        const made = (this.o.fs.lstat(path).mode ?? 0) & 0o7777;
        if ((made & ~want) !== 0) this.o.fs.chmod(path, made & want);
        return E.SUCCESS;
      },
      path_copy_file: this.copyImport(),
      umask: (mask: number, out: number) => {
        const old = this.umasks.set(mask);
        mem.view().setUint32(out, old, true);
      },
      fd_mode: (fd: number, out: number) => void mem.view().setUint32(out, fdMode(fd), true),
      path_mode: (dirfd: number, p: number, l: number, flags: number, out: number) => {
        const path = at(dirfd, p, l);
        const mode = pathMode(path, (flags & AT_SYMLINK_NOFOLLOW) === 0);
        mem.view().setUint32(out, mode, true);
      },
    });
  }

  private lockHost(mem: WasiMemory): LockHost {
    return {
      mem,
      file: (fd) => this.lockedFile(fd),
      flush: (file) => {
        if (file.path !== undefined) this.fds.flushPath(file.path);
        else if (file.target.fd !== undefined) this.o.kernel.sys.flush(file.target.fd);
      },
      locked: () => this.fds.holdLocks(),
      promote: (fd, moved) => this.fds.promote(fd, moved),
      reread: (fd) => this.fds.reread(fd),
      calls: {
        flock: (fd, kind, wait) =>
          this.fds.restarting(() =>
            this.o.kernel.call({ op: 'flock', fd, kind, ...(wait ? { wait } : {}) })
          ),
        set: (target, kind, start, len, wait) =>
          this.fds.restarting(() =>
            this.o.kernel.call({
              op: 'lk-set',
              ...target,
              kind,
              start,
              len,
              ...(wait ? { wait } : {}),
            })
          ),
        get: (target, kind, start, len) =>
          this.o.kernel.call({ op: 'lk-get', ...target, kind, start, len }) as LockHeld | null,
      },
    };
  }

  sliccImports(): Record<string, WasiFunction> {
    const { mem } = this;
    const path = (p: number, l: number) => {
      const text = mem.string(p, l);
      return text === '' || text.startsWith('/') ? text : normalize(`${this.cwd}/${text}`);
    };
    return wrap({
      mount: (
        sp: number,
        sl: number,
        tp: number,
        tl: number,
        fp: number,
        fl: number,
        flags: number,
        dp: number,
        dl: number
      ) =>
        void this.o.kernel.call({
          op: 'mount',
          source: mem.string(sp, sl),
          target: path(tp, tl),
          type: mem.string(fp, fl),
          flags,
          data: mem.string(dp, dl),
        }),
      umount2: (tp: number, tl: number, flags: number) =>
        void this.o.kernel.call({ op: 'umount', target: path(tp, tl), flags }),
      cred_get: (out: number) => {
        const cred = this.creds.get();
        const view = mem.view();
        view.getUint32(out + 20, true);
        IDS.forEach((key, i) => void view.setUint32(out + i * 4, cred[key], true));
      },
      cred_set: (...ids: number[]) => {
        const change: CredChange = {};
        IDS.forEach((key, i) => {
          if (ids[i] !== -1) change[key] = (ids[i] as number) >>> 0;
        });
        void this.creds.change(() => this.o.kernel.call({ op: 'proc-setcred', change }) as Cred);
      },
      ...semImports(this),
      ...lockImports(this.lockHost(mem)),
      groups_get: (buf: number, cap: number, count: number) => {
        const { groups } = this.creds.get();
        if (cap !== 0 && cap < groups.length) throw new WasiError('EINVAL');
        const shown = cap === 0 ? [] : groups;
        const view = mem.view();
        view.getUint32(count, true);
        if (shown.length > 0) view.getUint32(buf + (shown.length - 1) * 4, true);
        shown.forEach((g, i) => void view.setUint32(buf + i * 4, g, true));
        view.setUint32(count, groups.length, true);
      },
      groups_set: (buf: number, n: number) => {
        if (n < 0 || n > MAX_GROUPS) throw new WasiError('EINVAL');
        const view = mem.view();
        const groups = Array.from({ length: n }, (_, i) => view.getUint32(buf + i * 4, true));
        void this.creds.change(
          () => this.o.kernel.call({ op: 'proc-setcred', change: { groups } }) as Cred
        );
      },
      sigaction_set: (sig: number, disposition: number, flags: number) => {
        if (!this.signals) return E.NOSYS;
        const errno = this.signals.disposition(sig, disposition, flags);
        if (errno === E.SUCCESS && disposition === SIG_IGN) this.sigmask?.discard(sig);
        return errno;
      },
      sigmask_set: (how: number, lo: number, hi: number, old: number) => {
        if (!this.sigmask) return E.NOSYS;
        if (how === SIG_UNBLOCK || how === SIG_SETMASK) {
          this.signals?.unblocking(how === SIG_UNBLOCK ? lo << 1 : ~(lo << 1));
        }
        return this.sigmask.set(how, lo, hi, (oldLo, oldHi) => {
          if (old === 0) return;
          const view = mem.view();
          view.setUint32(old, oldLo, true);
          view.setUint32(old + 4, oldHi, true);
        });
      },
      sigmask_poll: (
        lo: number,
        hi: number,
        inPtr: number,
        outPtr: number,
        n: number,
        nevents: number
      ) =>
        this.sigmask
          ? this.maskedPoll(this.sigmask, [lo, hi], [inPtr, outPtr, n, nevents])
          : E.NOSYS,
      sigmask_epoll_wait: (
        lo: number,
        hi: number,
        epfd: number,
        events: number,
        max: number,
        timeout: bigint,
        nevents: number
      ) =>
        this.sigmask
          ? this.maskedEpoll(this.sigmask, [lo, hi], nevents, (epoll) =>
              epoll(epfd, events, max, timeout, nevents)
            )
          : E.NOSYS,
      sigwait: (lo: number, _hi: number, timeout: bigint, out: number) => {
        const mask = this.sigmask;
        if (!mask) return E.NOSYS;
        mem.view().setUint32(out, 0, true);
        return mask.sigwait(
          lo,
          timeout,
          (set) => void this.o.kernel.call({ op: 'sig-waiting', tid: mask.tid, set }),
          (sig) => void mem.view().setUint32(out, sig, true),
          this.entered
        );
      },
      sigwait_info: (lo: number, _hi: number, timeout: bigint, info: number) => {
        const mask = this.sigmask;
        if (!mask) return E.NOSYS;
        let took = 0;
        const r = mask.sigwait(
          lo,
          timeout,
          (set) => void this.o.kernel.call({ op: 'sig-waiting', tid: mask.tid, set }),
          (sig) => {
            took = sig;
          },
          this.entered
        );
        if (r === E.SUCCESS) this.writeSiginfo(info, took, mask.tid);
        return r;
      },
      siginfo_take: (sig: number, info: number) =>
        this.writeSiginfo(info, sig, this.sigmask?.tid ?? this.tid, false) ? E.SUCCESS : E.NOENT,
      sigaction_inherited: (out: number) => {
        const bits = this.o.kernel.call({ op: 'sig-inherited' }) as number;
        mem.view().setBigUint64(out, BigInt(libcBits(bits) >>> 0), true);
        return E.SUCCESS;
      },
      sigpending_get: (out: number) => {
        if (!this.sigmask) return E.NOSYS;
        mem.view().setBigUint64(out, BigInt(this.sigmask.pending()), true);
        return E.SUCCESS;
      },
    });
  }

  private poll(inPtr: number, outPtr: number, n: number, nevents: number, resume = true): number {
    const ran = this.signals?.ran ?? 0;
    try {
      return pollOneoff(
        {
          mem: this.mem,
          fds: this.fds,
          kernel: this.o.kernel,
          now: (id) => this.now(id),
          interruptWakes: this.interruptWakes,
          entered: this.entered,
          ...(resume ? { resumes: () => this.resumesPoll(ran) } : {}),
        },
        inPtr,
        outPtr,
        n,
        nevents
      );
    } finally {
      this.o.fs.invalidate?.();
    }
  }

  private resumesPoll(ran: number): boolean {
    this.interrupted?.();
    return (this.signals?.ran ?? 0) === ran;
  }

  private maskedPoll(
    mask: WasiSigmask,
    set: [number, number],
    [inPtr, outPtr, n, nevents]: number[]
  ): number {
    const old = mask.swap(set[0], set[1]);
    try {
      this.mem.view().setUint32(nevents, 0, true);
      if (mask.deliverUnblocked()) return E.INTR;
      this.settleEntry(mask);
      if (n > 0) return this.poll(inPtr, outPtr, n, nevents, false);
      return this.entered ? E.INTR : this.suspend();
    } finally {
      mask.deliverUnblocked();
      mask.restore(old);
    }
  }

  private epollWait: EpollWait | undefined;

  private settleEntry(mask: WasiSigmask): void {
    if (this.entered && (this.enteredSignals & ~mask.blockedBits()) === 0) this.entered = false;
  }

  private maskedEpoll(
    mask: WasiSigmask,
    set: [number, number],
    nevents: number,
    wait: (epoll: EpollWait) => number | undefined
  ): number {
    const old = mask.swap(set[0], set[1]);
    try {
      this.mem.view().setUint32(nevents, 0, true);
      if (mask.deliverUnblocked()) return E.INTR;
      this.settleEntry(mask);
      this.epollWait ??= wasixEpollImports(this).epoll_wait as unknown as EpollWait;
      return wait(this.epollWait) ?? E.SUCCESS;
    } finally {
      mask.deliverUnblocked();
      mask.restore(old);
    }
  }

  private suspend(): number {
    for (;;) {
      try {
        this.o.kernel.call({ op: 'fd-select', read: [], write: [], timeoutMs: -1 });
      } catch (e) {
        if ((e as { code?: unknown }).code === 'EINTR') return E.INTR;
        throw e;
      }
    }
  }

  imports(): Record<string, WasiFunction> {
    this.cache ??= wrap({
      ...this.processImports(),
      ...this.ioImports(),
      ...this.statImports(),
      ...this.pathImports(),
      ...this.socketImports(),
      poll_oneoff: (inPtr: number, outPtr: number, n: number, nevents: number) =>
        this.poll(inPtr, outPtr, n, nevents),
    });
    return this.cache;
  }

  now(id: number): bigint {
    if (id === CLOCK.REALTIME) return BigInt(Date.now()) * NS_PER_MS;

    if (id === CLOCK.MONOTONIC) {
      return MONOTONIC_BASE + BigInt(Math.round(performance.now() * 1e6));
    }
    return (localCpuNanos() ?? BigInt(Math.round((performance.now() - this.started) * 1e6))) + 1n;
  }

  private environ(): string[] {
    if (this.o.bare) return Object.entries(this.o.env).map(([k, v]) => `${k}=${v}`);
    const listen = this.listening.length > 0 ? { SLICC_LISTEN_FDS: this.listening.join(' ') } : {};
    const env = { PWD: this.cwd, ...this.o.env, ...listen };
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  }

  private processImports(): Record<string, WasiFunction> {
    const { mem } = this;
    return {
      args_get: (argv: number, buf: number) => void mem.putStrings(this.o.args, argv, buf),
      args_sizes_get: (n: number, size: number) => void mem.putSizes(this.o.args, n, size),
      environ_get: (envp: number, buf: number) => void mem.putStrings(this.environ(), envp, buf),
      environ_sizes_get: (n: number, size: number) => void mem.putSizes(this.environ(), n, size),
      clock_res_get: (_id: number, out: number) => void mem.view().setBigUint64(out, 1000n, true),
      clock_time_get: (id: number, _precision: bigint, out: number) =>
        void mem.view().setBigUint64(out, this.now(id), true),
      random_get: (buf: number, len: number) => {
        for (let at = 0; at < len; at += 65536) {
          const chunk = new Uint8Array(Math.min(65536, len - at));
          crypto.getRandomValues(chunk);
          mem.bytes(buf + at, chunk.length).set(chunk);
        }
      },
      sched_yield: () => E.SUCCESS,
      proc_exit: (code: number) => {
        throw new WasiExit(code);
      },
      proc_raise: (sig: number) => {
        const posix = WASI_SIGNAL_TO_POSIX[sig];
        if (posix === undefined) throw new WasiError('EINVAL');
        if (this.onRaise?.(posix)) return;
        this.o.kernel.call({ op: 'proc-kill', pid: this.o.pid, sig: posix });
      },
    };
  }

  private ioImports(): Record<string, WasiFunction> {
    const { mem, fds } = this;
    return {
      fd_write: (fd: number, iovs: number, n: number, out: number) =>
        void mem.view().setUint32(out, this.write(fd, mem.gather(iovs, n)), true),
      fd_read: (fd: number, iovs: number, n: number, out: number) => {
        const data = this.read(fd, mem.capacity(iovs, n));
        mem.view().setUint32(out, mem.scatter(iovs, n, data), true);
      },
      fd_pread: (fd: number, iovs: number, n: number, at: bigint, out: number) => {
        const data = this.positional(fd, 'read').pread(mem.capacity(iovs, n), Number(at));
        mem.view().setUint32(out, mem.scatter(iovs, n, data), true);
      },
      fd_pwrite: (fd: number, iovs: number, n: number, at: bigint, out: number) =>
        void mem
          .view()
          .setUint32(
            out,
            this.positional(fd, 'write').pwrite(mem.gather(iovs, n), Number(at)),
            true
          ),
      fd_seek: (fd: number, offset: bigint, whence: number, out: number) =>
        void mem.view().setBigUint64(out, BigInt(this.seek(fd, Number(offset), whence)), true),
      fd_tell: (fd: number, out: number) =>
        void mem.view().setBigUint64(out, BigInt(this.seek(fd, 0, WHENCE.CUR)), true),
      fd_close: (fd: number) => void fds.close(fd),
      fd_renumber: (from: number, to: number) => void fds.renumber(from, to),
      fd_sync: (fd: number) => void this.sync(fd),
      fd_datasync: (fd: number) => void this.sync(fd),
      fd_advise: (fd: number) => void fds.get(fd),
      fd_allocate: (fd: number, offset: bigint, len: bigint) => {
        const file = this.positional(fd, 'write');
        const end = Number(offset + len);
        if (end > file.size()) file.truncate(end);
      },
    };
  }

  private statImports(): Record<string, WasiFunction> {
    const { mem, fds } = this;
    return {
      fd_fdstat_get: (fd: number, out: number) => void this.fdstat(fd, out),
      fd_fdstat_set_flags: (fd: number, flags: number) =>
        void fds.setFlags(fd, (flags & FDFLAGS.NONBLOCK) !== 0, (flags & FDFLAGS.APPEND) !== 0),
      fd_fdstat_set_rights: (fd: number) => void fds.get(fd),
      fd_filestat_get: (fd: number, out: number) =>
        void this.writeFilestat(out, this.fdFilestat(fd)),
      fd_filestat_set_size: (fd: number, size: bigint) =>
        void this.positional(fd, 'write').truncate(Number(size)),
      fd_filestat_set_times: (fd: number, atim: bigint, mtim: bigint, flags: number) => {
        const e = fds.get(fd);
        if (e.type === 'file') {
          e.file.flush();
          this.setTimes(e.file.path, atim, mtim, flags);
        } else if (e.type === 'dir') this.setTimes(e.path, atim, mtim, flags);
      },
      fd_prestat_get: (fd: number, out: number) => {
        const name = new TextEncoder().encode(fds.preopen(fd).preopen);
        mem.view().setUint8(out, PREOPENTYPE_DIR);
        mem.view().setUint32(out + 4, name.length, true);
      },
      fd_prestat_dir_name: (fd: number, buf: number, len: number) => {
        const name = new TextEncoder().encode(fds.preopen(fd).preopen);
        mem.bytes(buf, Math.min(len, name.length)).set(name.subarray(0, len));
      },
      fd_readdir: (fd: number, buf: number, len: number, cookie: bigint, used: number) =>
        void this.readdir(fd, buf, len, Number(cookie), used),
    };
  }

  private pathImports(): Record<string, WasiFunction> {
    const { mem, fds, o } = this;
    const at = (dirfd: number, p: number, l: number) => fds.resolve(dirfd, mem.string(p, l));
    return {
      path_open: (
        dirfd: number,
        lookup: number,
        p: number,
        l: number,
        oflags: number,
        rights: bigint,
        _inheriting: bigint,
        fdflags: number,
        out: number
      ) => {
        const follow = (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0;
        try {
          const asked = at(dirfd, p, l);
          const alias = this.fdAlias(asked);
          if (alias && !alias.stdio) this.openFd(alias.fd);
          const path = alias && !alias.stdio ? `/dev/fd/${alias.fd}` : asked;
          if (deviceOf(path)) this.interrupted?.();
          mem
            .view()
            .setUint32(out, fds.open(path, oflags, rights, fdflags, undefined, !follow), true);
          if (fds.created) this.created(path, 0o666);
        } catch (err) {
          if ((err as { code?: string }).code !== 'ENOENT') throw err;
          const raw = mem.string(p, l);
          const joined = raw.startsWith('/') ? raw : `${fds.dir(dirfd).path}/${raw}`;
          const resolved = this.resolveForDev(joined, follow);
          if (!resolved) throw err;
          mem
            .view()
            .setUint32(out, fds.open(resolved, oflags, rights, fdflags, undefined, !follow), true);
        }
      },
      path_filestat_get: (dirfd: number, lookup: number, p: number, l: number, out: number) => {
        try {
          this.writeFilestat(out, this.pathFilestat(at(dirfd, p, l), lookup));
        } catch (err) {
          if ((err as { code?: string }).code !== 'ENOENT') throw err;
          const raw = mem.string(p, l);
          const joined = raw.startsWith('/') ? raw : `${fds.dir(dirfd).path}/${raw}`;
          const resolved = this.resolveForDev(joined, (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0);
          if (!resolved) throw err;
          this.writeFilestat(out, this.pathFilestat(resolved, lookup));
        }
      },
      path_filestat_set_times: (
        dirfd: number,
        lookup: number,
        p: number,
        l: number,
        atim: bigint,
        mtim: bigint,
        flags: number
      ) => {
        const path = at(dirfd, p, l);
        fds.flushPath(path);
        this.setTimes(path, atim, mtim, flags, (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0);
      },
      path_create_directory: (dirfd: number, p: number, l: number) => {
        const path = at(dirfd, p, l);
        if (o.fs.exists(path)) throw new WasiError('EEXIST');
        o.fs.mkdir(path);
        this.created(path, 0o777);
      },
      path_remove_directory: (dirfd: number, p: number, l: number) =>
        void o.fs.rmdir(at(dirfd, p, l)),
      path_unlink_file: (dirfd: number, p: number, l: number) => {
        const path = at(dirfd, p, l);
        if (inDevTree(path)) return void o.fs.unlink(path);
        const st = o.fs.lstat(path);
        if (st.isDirectory) throw new WasiError('EISDIR');
        const linked = linkedOf(st);
        fds.unlinking(path, linked);
        o.fs.unlink(path);
        fds.unlinked(path, linked);
      },
      path_rename: (fd: number, p: number, l: number, fd2: number, p2: number, l2: number) => {
        const from = at(fd, p, l);
        const to = at(fd2, p2, l2);
        fds.flushPath(from);
        const replaced = fds.holdsUnder(to) ? linkedElsewhere(o.fs, to) : undefined;
        const seq = o.fs.rename(from, to);
        fds.renamed(from, to, replaced);
        fds.ownRename(typeof seq === 'number' ? seq : undefined);
      },
      path_symlink: (tp: number, tl: number, dirfd: number, p: number, l: number) => {
        const path = at(dirfd, p, l);
        if (tl === 0) throw new WasiError('ENOENT');
        o.fs.symlink(mem.string(tp, tl), path);
      },
      path_readlink: (
        dirfd: number,
        p: number,
        l: number,
        buf: number,
        len: number,
        used: number
      ) => {
        const path = at(dirfd, p, l);
        const alias = this.fdAlias(path);
        const target = new TextEncoder().encode(alias ? this.fdTarget(alias) : o.fs.readlink(path));
        const n = Math.min(len, target.length);
        mem.bytes(buf, n).set(target.subarray(0, n));
        mem.view().setUint32(used, n, true);
      },

      path_link: (
        fd: number,
        lookup: number,
        p: number,
        l: number,
        fd2: number,
        p2: number,
        l2: number
      ) => {
        const from = at(fd, p, l);
        const to = at(fd2, p2, l2);
        const follow = (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0;
        const source = follow ? physicalPath(o.fs, from) : from;
        fds.flushPath(from);
        if (source !== from) fds.flushPath(source);
        o.fs.link(from, to, follow);
        fds.linked(from, to);
        if (source !== from) fds.linked(source, to);
      },
    };
  }

  private socket(fd: number): Extract<WasiEntry, { type: 'kernel' }> {
    const e = this.fds.get(fd);
    if (e.type !== 'kernel' || this.fds.kind(fd, e) !== 'socket') throw new WasiError('ENOTSOCK');
    return e;
  }

  private socketImports(): Record<string, WasiFunction> {
    const { mem, fds, o } = this;
    return {
      sock_accept: (fd: number, flags: number, out: number) => {
        const listener = this.socket(fd);
        const r = o.kernel.call({ op: 'sock-accept', fd, nonblock: listener.nonblock }) as {
          fd: number;
        };
        fds.adopt(r.fd, 'socket', (flags & FDFLAGS.NONBLOCK) !== 0);
        mem.view().setUint32(out, r.fd, true);
      },
      sock_recv: (
        fd: number,
        iovs: number,
        n: number,
        riflags: number,
        outLen: number,
        outFlags: number
      ) => {
        const e = this.socket(fd);
        if (this.fds.datagram(fd, e)) {
          return datagramCalls(this).recvFrom(
            fd,
            e.nonblock,
            iovs,
            n,
            riflags,
            outLen,
            outFlags,
            0
          );
        }
        const peek = (riflags & RIFLAGS.PEEK) !== 0;
        const want = mem.capacity(iovs, n);
        const data =
          (riflags & RIFLAGS.WAITALL) !== 0 && !peek
            ? this.recvAll(fd, want, e.nonblock)
            : o.kernel.sys.read(fd, Math.min(want, MAX_READ), { nonblock: e.nonblock, peek });
        mem.view().setUint32(outLen, mem.scatter(iovs, n, data), true);
        mem.view().setUint16(outFlags, 0, true);
      },

      sock_send: (fd: number, iovs: number, n: number, _flags: number, out: number) => {
        const e = this.socket(fd);
        const sent = o.kernel.sys.write(fd, mem.gather(iovs, n), { nonblock: e.nonblock });
        mem.view().setUint32(out, sent, true);
      },
      sock_shutdown: (fd: number, how: number) => {
        this.socket(fd);
        const both = SDFLAGS.RD | SDFLAGS.WR;
        if (how === 0 || (how & ~both) !== 0) throw new WasiError('EINVAL');

        o.kernel.call({
          op: 'sock-shutdown',
          fd,
          how: how === both ? 2 : how === SDFLAGS.WR ? 1 : 0,
        });
      },
    };
  }

  private recvAll(fd: number, want: number, nonblock: boolean): Uint8Array {
    const chunks: Uint8Array[] = [];
    let got = 0;
    while (got < want) {
      let chunk: Uint8Array;
      try {
        chunk = this.o.kernel.sys.read(fd, Math.min(want - got, MAX_READ), { nonblock });
      } catch (err) {
        if (got === 0) throw err;
        break;
      }
      if (chunk.length === 0) break;
      chunks.push(chunk);
      got += chunk.length;
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  private file(fd: number, access?: 'read' | 'write') {
    const e = this.fds.get(fd);
    if (e.type !== 'file') {
      throw new WasiError(e.type === 'dir' ? 'EISDIR' : e.type === 'kernel' ? 'ESPIPE' : 'EINVAL');
    }
    if ((access === 'read' && !e.file.readable) || (access === 'write' && !e.file.writable)) {
      throw new WasiError('EBADF');
    }
    return e.file;
  }

  private positional(fd: number, access?: 'read' | 'write'): Positional {
    const e = this.fds.get(fd);
    const kind = e.type === 'kernel' ? this.fds.kind(fd, e) : e.type;
    if (kind === 'device') this.interrupted?.();
    if (kind !== 'file' || e.type !== 'kernel') return this.file(fd, access);
    const kernel = this.o.kernel;
    return {
      pread: (max, at) => {
        if (!kernel.sys.pread) throw new WasiError('ESPIPE');
        return kernel.sys.pread(fd, Math.min(max, MAX_READ), at);
      },
      pwrite: (body, at) =>
        this.changed(fd, e, kernel.call({ op: 'fd-pwrite', fd, offset: at, body }) as number),
      size: () => this.kernelStat(fd).size,
      truncate: (size) => this.changed(fd, e, void kernel.call({ op: 'fd-resize', fd, size })),
    };
  }

  private readonly unnamed = new WeakSet<object>();

  private changed<T>(fd: number, e: { path?: string; ino?: number }, result: T): T {
    if (e.path === undefined && !this.unnamed.has(e)) this.learnPath(fd, e);
    this.o.fs.touched?.(e.path, e.ino);
    return result;
  }

  private learnPath(fd: number, e: { path?: string; ino?: number }): void {
    this.unnamed.add(e);
    let path: string | undefined;
    try {
      const st = this.o.kernel.call({ op: 'fd-vfs-stat', fd, identity: true }) as {
        path?: string;
        orphan?: true;
        ino?: number;
      };
      path = st.orphan ? undefined : st.path;
      if (path !== undefined) e.ino = st.ino ?? this.o.fs.stat(path).ino;
    } catch {
      return;
    }
    e.path = path;
  }

  private lockedFile(fd: number): LockedFile {
    const e = this.fds.get(fd);
    if (e.type === 'file') {
      const { file } = e;
      return {
        target: { path: file.path },
        path: file.path,
        readable: file.readable,
        writable: file.writable,
        offset: () => file.offset,
        size: () => file.size(),
      };
    }
    if (e.type !== 'kernel') throw new WasiError('EBADF');
    if (this.fds.kind(fd, e) !== 'file') return { target: { fd }, offset: () => 0, size: () => 0 };
    return {
      target: { fd },
      offset: () => this.o.kernel.sys.seek(fd, 0, WHENCE.CUR),
      size: () => this.kernelStat(fd).size,
    };
  }

  private kernelStat(fd: number): { path?: string; size: number; orphan?: true } {
    return this.o.kernel.call({ op: 'fd-vfs-stat', fd }) as {
      path?: string;
      size: number;
      orphan?: true;
    };
  }

  private write(fd: number, data: Uint8Array): number {
    if (this.muted?.(fd, data)) return data.length;
    const e = this.fds.get(fd);
    if (e.type === 'kernel') {
      try {
        const n = this.o.kernel.sys.write(fd, data, { nonblock: e.nonblock });
        return this.fds.kind(fd, e) === 'file' ? this.changed(fd, e, n) : n;
      } catch (err) {
        const broken = (err as { code?: string }).code === 'EPIPE';
        if (broken && this.fds.kind(fd, e) !== 'socket') this.brokenPipe();
        throw err;
      }
    }
    if (e.type === 'device') {
      this.interrupted?.();
      if (e.access === 'read') throw new WasiError('EBADF');
      if (e.device === 'full' && data.length > 0) throw new WasiError('ENOSPC');
      return data.length;
    }
    return this.file(fd, 'write').write(data);
  }

  private brokenPipe(): void {
    let action: unknown;
    try {
      action = this.o.kernel.call({ op: 'proc-kill-self', sig: SIG.PIPE, dry: true });
    } catch {
      action = 'terminate';
    }
    if (action === 'ignore') return;
    if (action === 'terminate' && !this.sigmask?.blocks(SIG.PIPE)) throw new WasiExit(SIGPIPE_EXIT);
    this.o.kernel.call({ op: 'thread-kill', tid: this.tid, sig: SIG.PIPE });
  }

  private read(fd: number, max: number): Uint8Array {
    const e = this.fds.get(fd);
    if (e.type === 'kernel') {
      return this.o.kernel.sys.read(fd, Math.min(max, MAX_READ), { nonblock: e.nonblock });
    }
    if (e.type === 'device') {
      this.interrupted?.();
      if (e.access === 'write') throw new WasiError('EBADF');
      if (e.device === 'null') return new Uint8Array(0);
      const out = new Uint8Array(Math.min(max, 65536));
      return e.device === 'urandom' ? crypto.getRandomValues(out) : out;
    }
    return this.file(fd, 'read').read(max);
  }

  private local<T>(answer: T): T {
    this.interrupted?.();
    return answer;
  }

  private seek(fd: number, offset: number, whence: number): number {
    const e = this.fds.get(fd);
    if (e.type === 'kernel') {
      const kind = this.fds.kind(fd, e);
      if (kind === 'device') return this.local(0);
      if (kind !== 'file') throw new WasiError('ESPIPE');
      return this.o.kernel.sys.seek(fd, offset, whence);
    }
    if (e.type === 'device') return this.local(0);
    const file = this.file(fd);
    const base = whence === WHENCE.SET ? 0 : whence === WHENCE.CUR ? file.offset : file.size();
    if (whence > WHENCE.END || base + offset < 0) throw new WasiError('EINVAL');
    file.offset = base + offset;
    return file.offset;
  }

  private sync(fd: number): void {
    const e = this.fds.get(fd);
    if (e.type === 'file') e.file.flush();
    else if (e.type === 'device') this.interrupted?.();
    else if (e.type === 'kernel') {
      const kind = this.fds.kind(fd, e);
      if (kind === 'file') this.o.kernel.sys.flush(fd);
      else if (kind === 'device') this.interrupted?.();
    }
  }

  private fdstat(fd: number, out: number): void {
    const e = this.fds.get(fd);
    if (e.type === 'device') this.interrupted?.();
    let filetype: number = FILETYPE.CHARACTER_DEVICE;
    let seeks = true;
    let flags = 0;
    if (e.type === 'kernel') {
      const kind = this.fds.kind(fd, e);
      if (kind === 'device') this.interrupted?.();
      ({ filetype, seeks } = kernelFiletype(this.fds.datagram(fd, e) ? 'dgram' : kind));
      if (e.nonblock) flags |= FDFLAGS.NONBLOCK;
      if (e.append) flags |= FDFLAGS.APPEND;
    } else if (e.type === 'file') {
      filetype = FILETYPE.REGULAR_FILE;
      if (e.file.append) flags |= FDFLAGS.APPEND;
    } else if (e.type === 'dir') filetype = FILETYPE.DIRECTORY;
    const v = this.mem.view();
    v.setUint8(out, filetype);
    v.setUint16(out + 2, flags, true);

    let rights = seeks ? RIGHTS.ALL : RIGHTS.ALL & ~(RIGHTS.FD_SEEK | RIGHTS.FD_TELL);
    if (e.type === 'kernel') {
      const access = this.o.kernel.sys.access?.(fd);
      if (access === 'read') rights &= ~RIGHTS.FD_WRITE;
      else if (access === 'write') rights &= ~RIGHTS.FD_READ;
    }
    v.setBigUint64(out + 8, rights, true);
    v.setBigUint64(out + 16, RIGHTS.ALL, true);
  }

  private writeFilestat(ptr: number, f: Filestat): void {
    const v = this.mem.view();
    v.setBigUint64(ptr, 1n, true);
    v.setBigUint64(ptr + 8, f.ino, true);
    v.setUint8(ptr + 16, f.filetype);
    v.setBigUint64(ptr + 24, f.nlink ?? 1n, true);
    v.setBigUint64(ptr + 32, f.size, true);
    v.setBigUint64(ptr + 40, f.mtimeNs, true);
    v.setBigUint64(ptr + 48, f.mtimeNs, true);
    v.setBigUint64(ptr + 56, f.mtimeNs, true);
  }

  private fdFilestat(fd: number): Filestat {
    const e = this.fds.get(fd);
    if (e.type === 'dir') return filestatOf(e.path, this.o.fs.stat(e.path));
    if (e.type === 'file') return this.localFilestat(e.file);
    const kind = e.type === 'kernel' ? this.fds.kind(fd, e) : undefined;
    if (kind === 'file') {
      const vfs = this.kernelStat(fd);
      if (vfs.path) return this.statOrphanable(vfs.path, vfs.size, vfs.orphan, vfs.orphan);
    }
    const filetype = kind ? kernelFiletype(kind).filetype : FILETYPE.CHARACTER_DEVICE;
    return this.local({ filetype, size: 0n, ino: BigInt(fd + 1), mtimeNs: 0n });
  }

  private localFilestat(file: LocalFile): Filestat {
    const { buffer } = file;
    if (buffer.isOrphan()) return this.statOrphanable(file.path, file.size(), false, true);
    let s: SyncFsBridgeStat | undefined;
    try {
      s = this.o.fs.stat(file.path);
    } catch {
      s = this.keptStat(buffer.handle);
    }
    return this.sized(file.path, s, file.size());
  }

  private keptStat(handle: number | undefined): SyncFsBridgeStat | undefined {
    if (handle === undefined) return undefined;
    try {
      return this.o.fs.keptStat?.(handle);
    } catch {
      return undefined;
    }
  }

  private sized(path: string, s: SyncFsBridgeStat | undefined, size: number): Filestat {
    return {
      ...filestatOf(path, s ?? { isFile: true, isDirectory: false, size: 0 }),
      size: BigInt(size),
    };
  }

  private statOrphanable(path: string, size: number, orphan = false, gone = false): Filestat {
    let s: SyncFsBridgeStat | undefined;

    if (!orphan) {
      try {
        s = this.o.fs.stat(path);
      } catch {}
    }
    const out = this.sized(path, s, size);
    return gone ? { ...out, nlink: 0n } : out;
  }

  private synthetic(path: string): boolean {
    return (
      deviceOf(path) !== undefined ||
      (path === SEALED_PATH && !!this.o.kernel.sys.openSealed) ||
      (path === CLIPBOARD_PATH && !!this.o.kernel.sys.openClipboard)
    );
  }

  private linkedDev(path: string, follow: boolean): string | undefined {
    if (!follow) return undefined;
    const real = physicalLeaf(this.o.fs, path);
    return real !== undefined && real !== path && kernelDev(real) ? real : undefined;
  }

  private statOf(path: string, follow: boolean): SyncFsBridgeStat {
    return follow ? this.o.fs.stat(path) : this.o.fs.lstat(path);
  }

  private viaDev<T>(
    path: string,
    follow: boolean,
    stat: () => T,
    device: (path: string, follow: boolean) => T
  ): T {
    try {
      return stat();
    } catch (err) {
      const linked = (err as { code?: string }).code === 'ENOENT' && this.linkedDev(path, follow);
      if (!linked) throw err;
      return device(linked, true);
    }
  }

  private devChar(path: string, follow: boolean): boolean {
    try {
      const json = (req: Parameters<WasiHost['o']['kernel']['call']>[0]) => this.o.kernel.call(req);
      const st = devSync({ json }, devStat(path, follow));
      return ((st.mode ?? 0) & 0o170000) === 0o020000;
    } catch {
      return false;
    }
  }

  private resolveForDev(path: string, follow = true): string | undefined {
    try {
      if (!follow) {
        const slash = path.lastIndexOf('/');
        if (slash <= 0) return undefined;
        const parent = physicalLeaf(this.o.fs, path.slice(0, slash));
        const resolved = parent === undefined ? undefined : `${parent}/${path.slice(slash + 1)}`;
        return resolved !== undefined && resolved !== path && this.synthetic(resolved)
          ? resolved
          : undefined;
      }
      const resolved = physicalLeaf(this.o.fs, path);
      return resolved !== undefined && resolved !== path && this.synthetic(resolved)
        ? resolved
        : undefined;
    } catch {
      return undefined;
    }
  }

  private writeSiginfo(at: number, sig: number, tid: number, waited = true): boolean {
    const taken = this.o.kernel.call({ op: 'sig-info', sig, tid }) as SigInfo | null;
    if (!taken && !waited) return false;
    const info = taken ?? KERNEL_SIGINFO;
    const view = this.mem.view();
    const size = Math.min(view.getUint32(at, true), SIGINFO_BYTES);
    const fields = [sig, info.code, info.pid, info.uid, info.status];
    let filled = 4;
    for (const [i, value] of fields.entries()) {
      if (4 + (i + 1) * 4 > size) break;
      view.setInt32(4 + at + i * 4, value, true);
      filled = 4 + (i + 1) * 4;
    }
    view.setUint32(at, filled, true);
    return true;
  }

  private fdAlias(path: string): FdAlias | undefined {
    const m = FD_ALIAS.exec(path);
    if (!m) return undefined;
    if (m[1]) return { fd: STDIO_FDS[m[1]] as number, stdio: true };
    if (m[3] !== undefined && m[3] !== 'self' && Number(m[3]) !== this.o.pid) return undefined;
    return { fd: Number(m[2] ?? m[4]), stdio: false };
  }

  private openFd(fd: number): void {
    try {
      this.fds.get(fd);
    } catch {
      throw new WasiError('ENOENT');
    }
  }

  private fdTarget(alias: FdAlias): string {
    if (alias.stdio) return `/proc/self/fd/${alias.fd}`;
    this.openFd(alias.fd);
    const e = this.fds.get(alias.fd);
    if (e.type === 'file') return e.file.path;
    if (e.type === 'dir') return e.path;
    if (e.type === 'device') return `/dev/${e.device}`;
    const kind = e.type === 'kernel' ? this.fds.kind(alias.fd, e) : undefined;
    if (kind === 'file') {
      const vfs = this.kernelStat(alias.fd);
      if (vfs.path) return vfs.path;
    }
    if (kind === 'tty') return '/dev/tty';
    if (kind === 'device') return '/dev/null';
    if (kind === 'stream') {
      const { fifo } = this.o.kernel.call({ op: 'fd-info', fd: alias.fd }) as FdInfo;
      if (fifo !== undefined) return fifo;
    }
    const ino = this.fdFilestat(alias.fd).ino;
    if (kind === 'stream') return `pipe:[${ino}]`;
    if (kind === 'socket') return `socket:[${ino}]`;
    return `anon_inode:[${kind ?? 'fd'}]`;
  }

  private aliasFilestat(path: string, alias: FdAlias, lookup: number): Filestat {
    if ((lookup & LOOKUP_SYMLINK_FOLLOW) === 0) {
      const target = this.fdTarget(alias);
      return this.local({
        filetype: FILETYPE.SYMBOLIC_LINK,
        size: BigInt(new TextEncoder().encode(target).length),
        ino: pathInode(path),
        mtimeNs: 0n,
      });
    }
    this.openFd(alias.fd);
    return this.fdFilestat(alias.fd);
  }

  private pathFilestat(path: string, lookup: number): Filestat {
    const alias = this.fdAlias(path);
    if (alias) return this.aliasFilestat(path, alias, lookup);
    if (this.synthetic(path)) {
      return this.local({
        filetype: FILETYPE.CHARACTER_DEVICE,
        size: 0n,
        ino: pathInode(path),
        mtimeNs: 0n,
      });
    }
    this.fds.flushPath(path);
    const follow = (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0;
    try {
      return filestatOf(path, follow ? this.o.fs.stat(path) : this.o.fs.lstat(path));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
      const device = kernelDev(path) ? path : this.linkedDev(path, follow);
      const alias = device && device !== path ? this.fdAlias(device) : undefined;
      if (device && alias) return this.aliasFilestat(device, alias, lookup);
      if (device && this.devChar(device, true)) {
        return this.local({
          filetype: FILETYPE.CHARACTER_DEVICE,
          size: 0n,
          ino: pathInode(device),
          mtimeNs: 0n,
        });
      }
      const resolved = this.resolveForDev(path, follow);
      if (!resolved) throw err;
      return this.local({
        filetype: FILETYPE.CHARACTER_DEVICE,
        size: 0n,
        ino: pathInode(resolved),
        mtimeNs: 0n,
      });
    }
  }

  private setTimes(path: string, atim: bigint, mtim: bigint, flags: number, follow = true): void {
    const asked = FSTFLAGS.ATIM | FSTFLAGS.ATIM_NOW | FSTFLAGS.MTIM | FSTFLAGS.MTIM_NOW;
    if (this.o.fs.owners && (flags & asked) === 0) return;
    const now = Date.now();
    let current: SyncFsBridgeStat | undefined;
    const statOf = follow ? this.o.fs.stat.bind(this.o.fs) : this.o.fs.lstat.bind(this.o.fs);
    const kept = (field: 'atimeMs' | 'mtimeMs'): number => {
      current ??= statOf(path);
      return current[field] ?? current.mtimeMs ?? now;
    };
    const pick = (
      set: number,
      setNow: number,
      value: bigint,
      field: 'atimeMs' | 'mtimeMs'
    ): number => (flags & setNow ? now : flags & set ? Number(value / NS_PER_MS) : kept(field));
    (follow ? this.o.fs.utimes : this.o.fs.lutimes).call(
      this.o.fs,
      path,
      pick(FSTFLAGS.ATIM, FSTFLAGS.ATIM_NOW, atim, 'atimeMs'),
      pick(FSTFLAGS.MTIM, FSTFLAGS.MTIM_NOW, mtim, 'mtimeMs'),
      (flags & (FSTFLAGS.ATIM | FSTFLAGS.MTIM)) === 0
    );
  }

  private readdir(fd: number, buf: number, len: number, cookie: number, usedPtr: number): void {
    const dir = this.fds.dir(fd);
    if (cookie === 0 || !dir.listing) {
      dir.listing = this.fds.goneCwd(dir) ? { names: [], stats: new Map() } : this.list(dir.path);
    }
    const { names, stats } = dir.listing;
    let at = 0;
    for (let i = cookie; i < names.length && at < len; i++) {
      const name = names[i];
      const full =
        name === '.'
          ? dir.path
          : name === '..'
            ? normalize(`${dir.path}/..`)
            : resolveUnder(dir.path, name);
      if (!stats.has(name)) stats.set(name, this.lstatOrNull(full));
      const st = stats.get(name) ?? null;
      const record = direntRecord(
        i + 1,
        st?.ino !== undefined ? BigInt(st.ino) : pathInode(full),
        name,
        filetypeOf(st)
      );
      const n = Math.min(record.length, len - at);
      this.mem.bytes(buf + at, n).set(record.subarray(0, n));
      at += n;
    }
    this.mem.view().setUint32(usedPtr, at, true);
  }

  private list(path: string): DirListing {
    const { fs } = this.o;
    const listed = fs.readdirStat(path);
    return { names: ['.', '..', ...listed.map(([name]) => name)], stats: new Map(listed) };
  }

  private lstatOrNull(path: string): SyncFsBridgeStat | null {
    try {
      return this.o.fs.lstat(path);
    } catch {
      return null;
    }
  }

  flushAll(): void {
    this.fds.flushAll();
  }
}

function direntRecord(next: number, ino: bigint, name: string, filetype: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const record = new Uint8Array(SIZE.DIRENT + nameBytes.length);
  const v = new DataView(record.buffer);
  v.setBigUint64(0, BigInt(next), true);
  v.setBigUint64(8, ino, true);
  v.setUint32(16, nameBytes.length, true);
  v.setUint8(20, filetype);
  record.set(nameBytes, SIZE.DIRENT);
  return record;
}

export function wrap(table: Record<string, WasiFunction>): Record<string, WasiFunction> {
  const out: Record<string, WasiFunction> = {};
  for (const [name, fn] of Object.entries(table)) {
    out[name] = (...args: never[]) => {
      try {
        return fn(...args) ?? E.SUCCESS;
      } catch (e) {
        if (e instanceof WasiExit) throw e;
        if (e instanceof WasiError) return wasiErrnoOf(e.code);
        const code = (e as { code?: unknown } | null)?.code;
        if (typeof code === 'string') return wasiErrnoOf(code);
        if (e instanceof RangeError) return E.FAULT;
        throw e;
      }
    };
  }
  return out;
}
