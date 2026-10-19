import { type CrontabCall, type CrontabResult, crontabCall } from '../cron/crontab.ts';
import { R_OK, W_OK, walk } from '../fs/access.ts';
import {
  type Created,
  type Dac,
  deny,
  type Guard,
  heldChmodMode,
  heldRetimable,
  inParent,
  openable,
  TTY_MODE,
  ttyOpenable,
} from '../fs/dac.ts';
import { chownAs } from '../fs/owners.ts';
import type { FsStat, KernelFs, NewOwner, Perm } from '../fs/types.ts';
import type { Replacements } from '../fs/unlinked.ts';
import type { MountCall } from '../mount/syscall.ts';
import { inProc, ProcTree, procAlias } from '../process/wasi/wasi-procfs.ts';
import type { LinkRecord } from '../process/wasi/wasix-linker.ts';
import type { SourceCheck } from '../realm/sync-fs-token-registry.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import type { SudoCall, SudoResult } from '../sudo.ts';
import {
  type ChildEvent,
  type ChildForker,
  type ChildSpawner,
  type ChildStdio,
  ChildTable,
  type InheritedSlot,
  SpawnError,
} from './children.ts';
import type { ClipboardBroker, ClipboardChannel, ClipboardStamp } from './clipboard.ts';
import { type Cred, type CredChange, changeCred, copyCred, ROOT } from './cred.ts';
import { EPOLL_OPS, type EpollSyscall, epollSyscall } from './epoll.ts';
import { EventFd } from './eventfd.ts';
import {
  type DeviceAccess,
  deviceAt,
  deviceFile,
  type FdTable,
  type HeldMeta,
  heldFile,
  KernelError,
  type KernelFdKind,
  type KernelFile,
  kernelFdKind,
  memoryFile,
  type OpenFile,
  openAccess,
  openPipe,
  pollFile,
} from './fd-table.ts';
import type { FifoTable } from './fifo.ts';
import { AsyncOps, HOST_OPS, type HostSyscall, hostSyscall, type LockTarget } from './host-ops.ts';
import type { JobTable } from './jobs.ts';
import type { KernelLocks } from './lock-service.ts';
import type { LockKind } from './locks.ts';
import { HTTP_OPS, type HttpHandles, type HttpSyscall } from './net/http-syscalls.ts';
import { NO_TRANSPORT } from './net/network.ts';
import { Resolver } from './net/resolver.ts';
import { Routes } from './net/routes.ts';
import type { MountLine, ProcessListing } from './proc-info.ts';
import type { DlState, ForkState } from './protocol.ts';
import { PTY_OPS, type PtySyscall, type PtyTable, ptsNumber, ptySyscall, sizeKey } from './pty.ts';
import { type RunRequest, runChild } from './run-child.ts';
import type { SealedBroker, SealedCaller } from './sealed.ts';
import { selectFds } from './select.ts';
import { SEM_OPS, SemHandles, type SemSyscall, type SemTable, semSyscall } from './sem.ts';
import {
  CLD,
  type DefaultAction,
  defaultAction,
  isSignal,
  KERNEL_SIGINFO,
  SI,
  SIG,
  type SigInfo,
  sigbit,
} from './signals.ts';
import { KernelSocket, LoopbackNet } from './socket.ts';
import { socketNames } from './socket-nodes.ts';
import { SOCKET_OPS, type SocketSyscall, socketSyscall } from './socket-syscalls.ts';
import { testSyscallHook } from './test-hooks.ts';
import { repeating } from './timer.ts';
import type { KernelTty, Termios } from './tty.ts';
import { isDatagram } from './unix-dgram.ts';
import {
  present,
  refuseReadonly,
  type VersionPin,
  type VfsFileFs,
  VfsNodes,
  vfsFile,
} from './vfs-file.ts';
import {
  isWatchSyscall,
  ProcessWatches,
  WATCH_OPS,
  type WatchSource,
  type WatchSyscall,
} from './watch-ops.ts';

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new KernelError('EINTR')), { once: true });
  });
}

export type WasmSyscall =
  | {
      op: 'fd-read';
      fd: number;
      max: number;

      nonblock?: boolean;

      peek?: boolean;
    }
  | { op: 'fd-write'; fd: number; body: Uint8Array; nonblock?: boolean }
  | { op: 'fd-close'; fd: number }
  | { op: 'fd-pipe' }
  | { op: 'fd-poll'; fd: number }
  | {
      op: 'fd-open-vfs';
      path: string;
      flags: number;
      position: number;
      mode?: number;

      contents?: Uint8Array;

      orphan?: boolean;

      truncate?: boolean;

      create?: boolean;

      exclusive?: boolean;

      created?: boolean;

      existing?: boolean;

      pin?: VersionPin;

      handle?: number;

      ino?: number;

      fifo?: boolean;
    }
  | { op: 'fd-pread'; fd: number; offset: number; max: number }
  | { op: 'fd-pwrite'; fd: number; offset: number; body: Uint8Array }
  | { op: 'fd-resize'; fd: number; size: number }
  | { op: 'fd-vfs-stat'; fd: number; identity?: boolean; full?: boolean }
  | { op: 'fd-chmod'; fd: number; mode: number }
  | { op: 'fd-chown'; fd: number; uid?: number; gid?: number }
  | { op: 'fd-utimes'; fd: number; atimeMs: number | null; mtimeMs: number | null; now?: boolean }
  | { op: 'fd-path-flush'; path: string }
  | { op: 'fd-path-unlinking'; path: string }
  | { op: 'fd-path-unlinked'; path: string }
  | { op: 'fd-path-renamed'; from: string; to: string }
  | { op: 'fd-seek'; fd: number; offset: number; whence: number }
  | { op: 'fd-select'; read: number[]; write: number[]; timeoutMs: number }
  | { op: 'fd-info'; fd: number }
  | { op: 'fd-dup'; fd: number; min?: number }
  | { op: 'fd-reserve'; fd?: number; min?: number; meta?: HeldMeta }
  | { op: 'fd-meta'; fd: number; meta: HeldMeta }
  | { op: 'fd-setfl'; fd: number; flags: number }
  | { op: 'fd-cloexec'; fd: number; on: boolean }
  | { op: 'fd-list' }
  | { op: 'dl-log'; append?: LinkRecord; from: number }
  | { op: 'dl-closure'; floor: number }
  | { op: 'dl-reserve'; floor: number; size: number }
  | { op: 'dl-load-reserve'; floor: number; size: number }
  | { op: 'dl-lock'; owner: number }
  | { op: 'dl-unlock'; owner: number }
  | { op: 'dl-closure-free'; index: number }
  | {
      op: 'proc-alarm';
      sig: number;
      ms: number;
      firstMs?: number;
      repeat: boolean;

      timer?: number;
    }
  | { op: 'fd-renumber'; from: number; to: number; keep?: boolean }
  | { op: 'proc-umask'; mask?: number }
  | { op: 'proc-cred' }
  | { op: 'proc-setcred'; change: CredChange }
  | {
      op: 'fd-promote';
      fd: number;
      share?: number;
      path?: string;
      flags?: number;
      position?: number;
      contents?: Uint8Array;
      orphan?: boolean;

      dirty?: boolean;

      pin?: VersionPin;

      handle?: number;

      ino?: number;
    }
  | { op: 'fd-open-tty'; name?: string }
  | { op: 'fd-tty-names' }
  | { op: 'fd-tty-owner'; name: string }
  | { op: 'fd-open-sealed'; flags: number }
  | { op: 'fd-open-clipboard'; flags: number }
  | { op: 'fd-clipboard-abort'; fd: number }
  | { op: 'tty-get'; fd: number }
  | { op: 'tty-set'; fd: number; termios: Termios; flush?: boolean }
  | { op: 'tty-winsz'; fd: number }
  | { op: 'fd-flush'; fd: number }
  | {
      op: 'proc-spawn';
      file: string;
      argv: string[];
      argv0?: string;
      env: Record<string, string>;
      cwd: string;
      chdir?: true;
      stdio: ChildStdio[];
      pgid?: number;
      session?: true;
      deathSignal?: number;

      inherit?: InheritedSlot[];

      exec?: boolean;
      search?: false;

      restart?: true;
    }
  | {
      op: 'proc-wait';
      pid: number;
      nohang: boolean;

      untraced?: boolean;
      continued?: boolean;
    }
  | { op: 'proc-captured'; pid: number; slot: number }
  | SudoCall
  | CrontabCall
  | RunRequest
  | { op: 'proc-exit'; status: number }
  | { op: 'proc-kill-self'; sig: number; target?: number; probe?: boolean; dry?: boolean }
  | { op: 'proc-fork'; state: ForkState; restart?: true }
  | { op: 'proc-kill'; pid: number; sig: number }
  | { op: 'thread-kill'; tid: number; sig: number }
  | { op: 'proc-list' }
  | { op: 'mount-list' }
  | ({ op: 'mount' } & MountCall)
  | { op: 'umount'; target: string; flags: number }
  | { op: 'proc-exec'; pid: number }
  | { op: 'proc-identity' }
  | { op: 'proc-setpgid'; pid: number; pgid: number }
  | { op: 'proc-getpgid'; pid: number }
  | { op: 'proc-getsid'; pid: number }
  | { op: 'proc-setsid' }
  | { op: 'tty-pgrp-get'; fd: number }
  | { op: 'tty-pgrp-set'; fd: number; pgrp: number }
  | { op: 'sig-mask'; caught: number; ignored: number; defaults?: number; nocldwait?: boolean }
  | { op: 'sig-inherited' }
  | { op: 'sig-waiting'; tid: number; set: number }
  | { op: 'sig-info'; sig: number; tid?: number }
  | { op: 'sig-pause' }
  | SocketSyscall
  | EpollSyscall
  | SemSyscall
  | HttpSyscall
  | PtySyscall
  | HostSyscall
  | WatchSyscall;

type FdSyscall = Extract<WasmSyscall, { op: `fd-${string}` }>;

type JobSyscall = Extract<
  WasmSyscall,
  { op: 'proc-setpgid' | 'proc-getpgid' | 'proc-getsid' | 'proc-setsid' }
>;

const PLAIN_FILE_MODE = 0o644;
const JOB_OPS: ReadonlySet<string> = new Set([
  'proc-setpgid',
  'proc-getpgid',
  'proc-getsid',
  'proc-setsid',
]);

function isJobSyscall(req: WasmSyscall): req is JobSyscall {
  return JOB_OPS.has(req.op);
}

function isHttpSyscall(req: WasmSyscall): req is HttpSyscall {
  return req.op.startsWith('net-');
}

function isSocketSyscall(req: WasmSyscall): req is SocketSyscall {
  return req.op.startsWith('sock-');
}

function isSemSyscall(req: WasmSyscall): req is SemSyscall {
  return req.op.startsWith('sem-');
}

function isEpollSyscall(req: WasmSyscall): req is EpollSyscall {
  return (EPOLL_OPS as readonly string[]).includes(req.op);
}

function isHostSyscall(req: { op: string }): req is HostSyscall {
  return (HOST_OPS as readonly string[]).includes(req.op);
}

function isPtySyscall(req: WasmSyscall): req is PtySyscall {
  return req.op.startsWith('pty-');
}

type VfsSyscall = Extract<
  FdSyscall,
  {
    op:
      | 'fd-pread'
      | 'fd-pwrite'
      | 'fd-resize'
      | 'fd-vfs-stat'
      | 'fd-chmod'
      | 'fd-chown'
      | 'fd-utimes'
      | 'fd-path-flush'
      | 'fd-path-unlinking'
      | 'fd-path-unlinked'
      | 'fd-path-renamed';
  }
>;

function isVfsSyscall(req: FdSyscall): req is VfsSyscall {
  return (
    req.op.startsWith('fd-path-') ||
    req.op === 'fd-pread' ||
    req.op === 'fd-pwrite' ||
    req.op === 'fd-resize' ||
    req.op === 'fd-vfs-stat' ||
    req.op === 'fd-chmod' ||
    req.op === 'fd-chown' ||
    req.op === 'fd-utimes'
  );
}

function isFdSyscall(req: WasmSyscall): req is FdSyscall {
  return req.op.startsWith('fd-');
}

function isTtySyscall(req: WasmSyscall): req is TtySyscall {
  return req.op.startsWith('tty-');
}

export interface FdInfo {
  tty: boolean;
  kind: KernelFdKind;
  dgram?: true;
  meta?: HeldMeta;
  flags?: number;
  cloexec?: true;

  access?: DeviceAccess;

  name?: string;
  terminal?: string;
  fifo?: string;
}

const SYSCALL_OPS: ReadonlySet<string> = new Set([
  'fd-read',
  'fd-write',
  'fd-close',
  'fd-pipe',
  'fd-poll',
  'fd-open-vfs',
  'fd-seek',
  'fd-pread',
  'fd-pwrite',
  'fd-resize',
  'fd-vfs-stat',
  'fd-chmod',
  'fd-chown',
  'fd-utimes',
  'fd-path-flush',
  'fd-path-unlinking',
  'fd-path-unlinked',
  'fd-path-renamed',
  'fd-select',
  'fd-info',
  'fd-dup',
  'fd-reserve',
  'fd-meta',
  'fd-setfl',
  'fd-cloexec',
  'fd-list',
  'proc-alarm',
  'proc-umask',
  'proc-cred',
  'proc-setcred',
  'dl-log',
  'dl-closure',
  'dl-closure-free',
  'dl-reserve',
  'dl-load-reserve',
  'dl-lock',
  'dl-unlock',
  'fd-renumber',
  'fd-promote',
  'fd-open-tty',
  'fd-tty-names',
  'fd-tty-owner',
  'fd-open-sealed',
  'fd-open-clipboard',
  'fd-clipboard-abort',
  'tty-get',
  'tty-set',
  'tty-winsz',
  'fd-flush',
  'proc-spawn',
  'proc-wait',
  'proc-captured',
  'proc-sudo',
  'proc-crontab',
  'proc-run',
  'proc-exit',
  'proc-kill-self',
  'proc-fork',
  'proc-kill',
  'thread-kill',
  'proc-list',
  'mount-list',
  'mount',
  'umount',
  'proc-exec',
  'proc-identity',
  'proc-setpgid',
  'proc-getpgid',
  'proc-getsid',
  'proc-setsid',
  'tty-pgrp-get',
  'tty-pgrp-set',
  'sig-mask',
  'sig-inherited',
  'sig-waiting',
  'sig-info',
  'sig-pause',
  ...SOCKET_OPS,
  ...EPOLL_OPS,
  ...SEM_OPS,
  ...HTTP_OPS,
  ...PTY_OPS,
  ...HOST_OPS,
  ...WATCH_OPS,
]);

type TtySyscall = Extract<WasmSyscall, { op: `tty-${string}` }>;

export function isWasmSyscall(req: object): req is WasmSyscall {
  const op = (req as { op?: unknown }).op;
  return typeof op === 'string' && SYSCALL_OPS.has(op);
}

const MAX_READ = 1024 * 1024;
const O_NONBLOCK = 0o4000;
const WRITE_ACCESS = 0o3;
const KEYBOARD: ReadonlySet<number> = new Set([SIG.INT, SIG.QUIT, SIG.TSTP]);

const STUCK_ESCAPES: ReadonlySet<number> = new Set([SIG.INT, SIG.TERM, SIG.QUIT, SIG.HUP]);

export const DEFAULT_UMASK = 0o022;

function words(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((w) => typeof w === 'string')) {
    throw new KernelError('EINVAL');
  }
  return [...value];
}

const ESCAPES: Readonly<Record<string, string>> = { '\t': '\\t', '\n': '\\n', '\r': '\\r' };

function clipboardLine(text: string): string {
  let out = '';
  for (const c of text) {
    const code = c.charCodeAt(0);
    const control = code < 0x20 || code === 0x7f;
    out += control ? (ESCAPES[c] ?? `\\x${code.toString(16).padStart(2, '0')}`) : c;
  }
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

let nextOpenKey = 1;

const fileKeys = new WeakMap<object, string>();

function identityKey(st: { ino?: number; dev?: number }, path: string): string {
  return st.ino === undefined ? path : `${st.dev ?? 0}:${st.ino}`;
}

const objectIds = new WeakMap<object, number>();

let nextObjectId = 1;

function objectKey(file: KernelFile): string {
  const at = file.tty ?? file.identity ?? file.pty ?? file;
  let id = objectIds.get(at);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(at, id);
  }
  return `object:${id}`;
}

const flockHooked = new WeakSet<OpenFile>();

const DYING: SyncFsResult = { ok: false, errno: 'EINTR', message: 'the process is being killed' };

const HOSTS_ONLY = new Resolver({ routes: new Routes() });

export interface WasmProcessOptions {
  ignored?: number;

  source?: SourceCheck;

  umask?: number;

  cred?: Cred;

  owners?: boolean;

  sealed?: SealedBroker;

  outputFilter?: (file: OpenFile) => OpenFile;

  clipboard?: ClipboardBroker;

  clipboardName?: string;

  readonlyAt?: (path: string) => boolean;

  guard?: { dac: Dac; fs: KernelFs; created?: Created; links?: number };

  noLinks?: KernelFs;

  identity?: () => Promise<{ pid: number; ppid: number }>;

  onSyscall?: (req: WasmSyscall) => void;

  spawner?: ChildSpawner;

  forker?: ChildForker;

  fs: VfsFileFs;

  kill?: (pid: number, sig: number, info?: SigInfo) => boolean | Promise<boolean>;

  writesBack?: (pid: number) => boolean;

  processes?: () => ProcessListing;

  sudo?: (call: SudoCall, signal: AbortSignal) => Promise<SudoResult>;

  crontab?: (call: CrontabCall) => Promise<CrontabResult>;

  openFiles?: Set<VfsNodes>;

  nodes?: VfsNodes;

  mounts?: () => MountLine[];

  mount?: (call: MountCall, signal: AbortSignal) => Promise<unknown>;

  umount?: (target: string, flags: number) => Promise<void>;

  onPending?: (sig: number) => void;

  onTimer?: (which: number) => void;

  onAsync?: () => void;

  hasPending?: () => boolean;

  threadKill?: (tid: number, sig: number) => boolean;

  unblockedThread?: (sig: number) => number | undefined;

  settling?: () => boolean;

  pendingBits?: () => number;

  blockedBits?: () => number;

  dl?: DlState;

  raise?: (sig: number, info?: SigInfo) => void;

  exitNow?: (status: number) => void;
  watches?: WatchSource | undefined;

  exitSignal?: (sig: number) => void;

  onReap?: (pid: number) => void;

  jobs?: JobTable;

  ptys?: PtyTable;

  net?: LoopbackNet;

  http?: HttpHandles;

  locks?: KernelLocks;

  fifos?: FifoTable;

  sems?: SemTable;

  resolver?: Resolver;
}

function timeLeft(req: WasmSyscall, started: number): WasmSyscall {
  if (!('timeoutMs' in req) || typeof req.timeoutMs !== 'number' || req.timeoutMs < 0) return req;
  return { ...req, timeoutMs: Math.max(0, req.timeoutMs - (performance.now() - started)) };
}

export type StateListener = (state: 'stopped' | 'continued', sig: number) => void;

export type SignalOutcome = DefaultAction | 'deliver' | 'forward';

export class WasmProcess {
  private exited = false;
  private readonly watches: ProcessWatches;
  private readonly children: ChildTable;

  private readonly deathSignals = new Map<number, number>();

  private caught = 0;
  private ignored = 0;
  private inherited = 0;

  private nocldwait = false;

  private interrupt = new AbortController();

  private readonly gone = new AbortController();

  private dying = false;

  umask = DEFAULT_UMASK;

  cred: Cred;

  private execChild: number | undefined;

  private killed = false;

  private calls = 0;

  private readonly pendingAt = new Map<number, number>();

  execTermsig: number | undefined;

  private stopped = 0;

  private stops = 0;
  private owed = false;
  private readonly waiting = new Set<AbortSignal>();
  private resumed: Promise<void> = Promise.resolve();
  private wake: (() => void) | undefined;
  private readonly stateListeners: StateListener[] = [];

  private net: LoopbackNet | undefined;

  private readonly nodes: VfsNodes;

  readonly pid: number;

  readonly fds: FdTable;

  private readonly options: WasmProcessOptions;

  constructor(
    pid: number,

    fds: FdTable,

    options: WasmProcessOptions
  ) {
    this.pid = pid;

    this.fds = fds;

    this.options = options;
    this.watches = new ProcessWatches(options.watches);
    this.inherited = options.ignored ?? 0;
    this.umask = options.umask ?? DEFAULT_UMASK;
    this.cred = copyCred(options.cred ?? ROOT);
    this.children = new ChildTable(fds, options.spawner, options.forker);
    this.nodes = options.nodes ?? new VfsNodes(options.fs);
    if (!options.nodes) options.openFiles?.add(this.nodes);
    this.children.onChildState = (child) => this.signal(SIG.CHLD, child && this.childInfo(child));
    this.children.autoReap = () => this.reapsChildren();
    this.seedDl(options.dl);
    this.children.onReap = (pid) => {
      this.deathSignals.delete(pid);
      options.onReap?.(pid);
    };
  }

  private ignores(bit: number): boolean {
    return (this.signalMasks().ignored & bit) !== 0;
  }

  signalMasks(): { ignored: number; caught: number } {
    return { ignored: this.ignored | (this.inherited & ~this.caught), caught: this.caught };
  }

  inheritable(fork = false): number {
    return ((fork ? 0 : this.ignored) | this.inherited) & ~this.caught;
  }

  private readonly sigInfos = new Map<string, SigInfo>();

  signal(sig: number, info?: SigInfo): SignalOutcome {
    const pending = ((this.options.pendingBits?.() ?? 0) & sigbit(sig)) !== 0;
    const outcome = this.signalOutcome(sig, info);
    if (outcome === 'deliver' && !(pending && this.sigInfos.has(`0:${sig}`))) {
      this.sigInfos.set(`0:${sig}`, info ?? KERNEL_SIGINFO);
    }
    return outcome;
  }

  private async threadKill(tid: number, sig: number): Promise<void> {
    const info = await this.threadSender(sig);
    if (this.options.threadKill?.(tid, sig)) this.sigInfos.set(`${tid}:${sig}`, info);
    else this.options.raise?.(sig, info);
  }

  private async threadSender(sig: number): Promise<SigInfo> {
    const pid = (await this.options.identity?.())?.pid ?? this.pid;
    const code = sig === SIG.PIPE ? SI.USER : SI.TKILL;
    return { code, pid, uid: this.cred.ruid, status: 0 };
  }

  private childInfo(child: ChildEvent): SigInfo {
    const code =
      child.state === 'stopped'
        ? CLD.STOPPED
        : child.state === 'continued'
          ? CLD.CONTINUED
          : child.termsig
            ? CLD.KILLED
            : CLD.EXITED;
    return { code, pid: child.pid, uid: child.uid ?? this.cred.ruid, status: child.status };
  }

  private takeSigInfo(sig: number, tid: number): SigInfo | null {
    for (const key of [`${tid}:${sig}`, `0:${sig}`]) {
      const info = this.sigInfos.get(key);
      if (info) {
        this.sigInfos.delete(key);
        return info;
      }
    }
    return null;
  }

  private signalOutcome(sig: number, info?: SigInfo): SignalOutcome {
    if (this.execChild !== undefined) {
      if (sig === SIG.CONT) this.cont();
      void Promise.resolve(this.options.kill?.(this.execChild, sig, info)).catch(() => undefined);
      if (sig !== SIG.KILL) return 'forward';
      if (!this.options.writesBack?.(this.execChild)) return 'terminate';
      this.wake?.();
      return 'forward';
    }
    if (sig === SIG.KILL) {
      this.killed = true;
      return 'terminate';
    }

    if (sig === SIG.CONT) this.cont();
    if (sig === SIG.STOP) return this.stop(sig);
    const bit = sigbit(sig);
    if (this.ignores(bit)) return 'ignore';
    if (((this.options.blockedBits?.() ?? 0) & bit) !== 0 && this.routeBlocked(sig, bit)) {
      return 'deliver';
    }
    if (!(this.caught & bit)) {
      const action = defaultAction(sig);
      return action === 'stop' ? this.stop(sig) : action;
    }
    if (((this.options.pendingBits?.() ?? 0) & bit) !== 0) {
      if (STUCK_ESCAPES.has(sig) && this.pendingAt.get(sig) === this.calls) return 'terminate';
    } else this.pendingAt.set(sig, this.calls);
    this.options.onPending?.(sig);
    if (this.options.jobs?.keyboard && KEYBOARD.has(sig) && this.waiting.size === 0)
      this.owed = true;
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
    return 'deliver';
  }

  private routeBlocked(sig: number, bit: number): boolean {
    const waiter = this.waiterFor(bit);
    const tid = waiter ?? this.options.unblockedThread?.(sig);
    if (tid === undefined || tid === 1) {
      this.options.onPending?.(sig);
      return true;
    }
    if (waiter === undefined && !(this.caught & bit)) return false;
    this.options.threadKill?.(tid, sig);
    return true;
  }

  private async spawn(req: Extract<WasmSyscall, { op: 'proc-spawn' }>): Promise<number> {
    const { file, argv, argv0, env, cwd, chdir, stdio, inherit, exec, pgid, session, deathSignal } =
      req;
    if (deathSignal !== undefined && (exec || !isSignal(deathSignal))) {
      throw new KernelError('EINVAL');
    }
    const group = { ...(pgid !== undefined ? { pgid } : {}), ...(session ? { session } : {}) };
    const named = argv0 !== undefined ? { argv0 } : {};
    const moved = chdir ? { chdir } : {};
    const spawned = {
      file,
      argv,
      ...named,
      env,
      cwd,
      ...moved,
      ...group,
      ...(exec ? { exec } : {}),
      search: req.search,
    };
    const pid = await this.children.spawn(spawned, stdio, inherit);
    if (deathSignal !== undefined) this.onDeath(pgid === 0 || session ? -pid : pid, deathSignal);
    if (!exec) return pid;
    if (this.killed) void Promise.allSettled([this.options.kill?.(pid, SIG.KILL)]);
    else this.adoptExec(pid);
    return pid;
  }

  private onDeath(target: number, sig: number): void {
    if (this.exited) this.sendDeath(target, sig);
    else this.deathSignals.set(target, sig);
  }

  private sendDeath(target: number, sig: number): void {
    void Promise.resolve(this.options.kill?.(target, sig)).catch(() => undefined);
  }

  private selfKill(req: Extract<WasmSyscall, { op: 'proc-kill-self' }>): Promise<SyncFsResult> {
    if (req.dry) return Promise.resolve(this.spares(req.sig));
    return this.killSelf(req.sig, req.target, req.probe);
  }

  private spares(sig: number): SyncFsResult {
    const { caught, ignored } = this.signalMasks();
    const bit = isSignal(sig) ? sigbit(sig) : 0;
    const answer = (ignored & bit) !== 0 ? 'ignore' : (caught & bit) !== 0 ? 'spare' : 'terminate';
    return { ok: true, kind: 'json', json: answer };
  }

  private async killSelf(sig: number, target?: number, probe?: boolean): Promise<SyncFsResult> {
    if (!this.options.exitSignal) throw new KernelError('ENOSYS');
    if (!isSignal(sig) || defaultAction(sig) !== 'terminate') throw new KernelError('EINVAL');
    const { caught, ignored } = this.signalMasks();
    const to = target === 0 ? -this.pgid() : (target ?? this.pid);
    if (sig !== SIG.KILL && (caught | ignored) & sigbit(sig)) {
      if (!(await this.options.kill?.(to, sig))) throw new KernelError('ESRCH');
      return { ok: true, kind: 'void' };
    }
    if (probe) return { ok: true, kind: 'json', json: 'terminate' };
    if (to !== this.pid) await this.options.kill?.(to, sig);
    this.options.exitSignal(sig);
    return DYING;
  }

  private run(req: RunRequest): Promise<Uint8Array> {
    return runChild(req, {
      children: this.children,
      kill: (pid, sig) => this.options.kill?.(pid, sig),
      interrupt: () => this.interrupt.signal,
      dying: () => this.dying,
    });
  }

  private adoptExec(pid: number): void {
    this.execChild = pid;
    this.children.keep(pid);
    this.children.watch(pid, (state, sig) => (state === 'stopped' ? this.stop(sig) : this.cont()));
  }

  onState(listener: StateListener): void {
    this.stateListeners.push(listener);
  }

  private stop(sig: number): 'stop' {
    if (this.stopped) return 'stop';
    this.stopped = sig;
    this.stops++;
    this.resumed = new Promise((resolve) => (this.wake = resolve));
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
    for (const listener of this.stateListeners) listener('stopped', sig);
    return 'stop';
  }

  private cont(): void {
    if (!this.stopped) return;
    this.stopped = 0;
    this.wake?.();
    for (const listener of this.stateListeners) listener('continued', SIG.CONT);
  }

  private readonly blocks = new WeakMap<AbortSignal, () => void>();

  private readonly sizesRead = new WeakMap<KernelTty, string>();

  private readonly sigwaiters = new Map<number, number>();

  private setSigwaiter(tid: number, set: number): void {
    if (set === 0) this.sigwaiters.delete(tid);
    else this.sigwaiters.set(tid, set);
  }

  private waiterFor(bit: number): number | undefined {
    if (((this.sigwaiters.get(1) ?? 0) & bit) !== 0) return 1;
    for (const [tid, set] of this.sigwaiters) if (set & bit) return tid;
    return undefined;
  }

  async syscall(
    req: WasmSyscall,
    cancelled?: AbortSignal,
    block?: () => void
  ): Promise<SyncFsResult> {
    const hook = testSyscallHook();
    if (hook) await hook({ pid: this.pid, op: req.op });
    this.options.onSyscall?.(req);
    this.calls += 1;
    const started = performance.now();
    let restarted = false;
    for (;;) {
      await this.resumed;
      if (this.dying) return DYING;
      const current = restarted ? timeLeft(req, started) : req;
      const stops = this.stops;
      const scope = new AbortController();
      const forward = () => scope.abort();
      if (cancelled?.aborted) scope.abort();
      cancelled?.addEventListener('abort', forward, { once: true });
      if (block) this.blocks.set(scope.signal, block);
      const result = await this.dispatch(current, scope.signal).finally(() => {
        cancelled?.removeEventListener('abort', forward);
        this.waiting.delete(scope.signal);
      });
      if (this.dying) return DYING;

      const restart = !result.ok && result.errno === 'EINTR' && this.stops !== stops;
      if (restart && !this.options.hasPending?.() && req.op !== 'epoll-wait') {
        restarted = true;
        continue;
      }

      await this.resumed;
      return result;
    }
  }

  setUmask(mask?: number): number {
    const old = this.umask;
    if (mask !== undefined) this.umask = mask & 0o777;
    return old;
  }

  die(): void {
    if (this.dying) return;
    this.dying = true;
    this.interrupt.abort();
    this.wake?.();
  }

  private async dispatch(req: WasmSyscall, cancelled: AbortSignal): Promise<SyncFsResult> {
    try {
      if (isFdSyscall(req)) return await this.fdSyscall(req, cancelled);
      if (isTtySyscall(req)) return this.ttySyscall(req);
      if (isJobSyscall(req)) return this.jobSyscall(req);
      if (isSocketSyscall(req)) return await this.socketSyscall(req, cancelled);
      if (isSemSyscall(req)) return await this.semSyscall(req, cancelled);
      if (isEpollSyscall(req)) {
        return await epollSyscall(req, {
          fds: this.fds,
          blocking: () => this.blockingSignal(cancelled),
          owed: () => this.owed,
        });
      }
      if (isHttpSyscall(req)) return await this.httpSyscall(req);
      if (isWatchSyscall(req)) return await this.watches.syscall(req, cancelled);
      if (isHostSyscall(req)) {
        return await hostSyscall(req, {
          pid: this.pid,
          owner: () => this.lockOwner(),
          fileKey: (target, kind, setting) => this.lockKey(target, kind, setting),
          flockOf: (fd) => this.flockOf(fd),
          settle: (fd, granted) => this.settle(fd, granted),
          locks: this.options.locks,
          ops: this.asyncOps,
          blocking: () => this.blockingSignal(cancelled),
          valid: (inner) => isWasmSyscall(inner) && !isHostSyscall(inner),
        });
      }
      if (isPtySyscall(req)) {
        const { ptys, jobs } = this.options;
        const owner = this.options.owners ? this.ttyOwner() : undefined;
        const guard = this.guarded();
        const { outputFilter } = this.options;
        const sizesRead = this.sizesRead;
        const ctx = {
          pid: this.pid,
          fds: this.fds,
          ptys,
          jobs,
          guard,
          owner,
          outputFilter,
          sizesRead,
        };
        return ptySyscall(req, ctx);
      }
      return await this.procSyscall(req, cancelled);
    } catch (e) {
      if (e instanceof KernelError || e instanceof SpawnError) {
        return { ok: false, errno: e.code, message: (e as KernelError).detail ?? e.code };
      }
      const code = (e as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
        return { ok: false, errno: code, message: code };
      }
      throw e;
    }
  }

  private readonly lockOwners = new Set<number>();

  private readonly lockChecked = new Set<string>();

  private lockOwner(): number {
    const owner = this.options.jobs?.shown(this.pid) ?? this.pid;
    this.lockOwners.add(owner);
    return owner;
  }

  private readonly pathKeys = new Map<string, string>();

  private async lockPath(target: LockTarget, want: number): Promise<string> {
    if (target.fd !== undefined) {
      const st = await this.fds.get(target.fd).file.stat?.();
      if (!st) throw new KernelError('EBADF');
      return st.path;
    }
    if (target.path === undefined) throw new KernelError('EINVAL');
    if (!target.path.startsWith('/')) throw new KernelError('EINVAL');
    const path = target.path;
    const g = this.guarded();
    const checked = `${want}:${path}`;
    if (g && want !== 0 && !this.lockChecked.has(checked)) {
      await openable(g, 'lock', path, want, false);
      this.lockChecked.add(checked);
    }
    return path;
  }

  private async lockKey(
    target: LockTarget,
    kind: LockKind | 'unlock' | 'close',
    setting = false
  ): Promise<string> {
    const file = target.fd === undefined ? undefined : this.fds.get(target.fd);
    const access = file?.file;
    if (setting && ((kind === 'read' && !access?.read) || (kind === 'write' && !access?.write)))
      throw new KernelError('EBADF');
    const known = file ? fileKeys.get(file) : this.pathKeys.get(target.path ?? '');
    if (kind === 'close' && !file && target.path !== undefined) this.pathKeys.delete(target.path);
    if (access && !access.stat) return objectKey(access);
    const want = kind === 'read' ? R_OK : kind === 'write' ? W_OK : 0;
    const path = await this.lockPath(target, want);
    if (known !== undefined) return known;
    const st = await this.options.fs.stat?.(path).catch((err: unknown) => {
      if (!file) throw err;
      return undefined;
    });
    if (!st && !file) throw new KernelError('ENOENT');
    const key = st ? identityKey(st, path) : `open:${nextOpenKey++}`;
    if (kind === 'close') return key;
    if (file) fileKeys.set(file, key);
    else if (this.pathKeys.size < 4096) this.pathKeys.set(path, key);
    return key;
  }

  private async settle(fd: number, granted: boolean): Promise<void> {
    const file = this.fds.has(fd) ? this.fds.get(fd).file : undefined;
    if (granted) await file?.reread?.();
    else await file?.flush?.();
  }

  private async flockOf(fd: number): Promise<{ key: string; owner: OpenFile }> {
    const open = this.fds.get(fd);
    const { locks } = this.options;
    if (locks && !flockHooked.has(open)) {
      flockHooked.add(open);
      open.onClose(() => locks.flocks.drop(open));
    }
    return { key: await this.objectKeyOf(open), owner: open };
  }

  private async objectKeyOf(open: OpenFile): Promise<string> {
    const { file } = open;
    const meta = file.heldMeta;
    if (meta && 'device' in meta) return `device:${meta.device}`;
    if (meta && 'dir' in meta) {
      const st = await this.options.fs.stat?.(meta.dir).catch(() => undefined);
      return st ? identityKey(st, meta.dir) : objectKey(file);
    }
    const known = fileKeys.get(open);
    if (known !== undefined) return known;
    const vfs = await file.stat?.().catch(() => undefined);
    if (!vfs || vfs.orphan) return objectKey(file);
    const st = await this.options.fs.stat?.(vfs.path).catch(() => undefined);
    if (!st) return objectKey(file);
    const key = identityKey(st, vfs.path);
    fileKeys.set(open, key);
    return key;
  }

  private async dropRecordLocks(fd: number): Promise<void> {
    const { locks } = this.options;
    const owner = this.options.jobs?.shown(this.pid) ?? this.pid;
    if (!locks?.holds(owner) || !this.fds.has(fd)) return;
    const key = await this.lockKey({ fd }, 'close').catch(() => undefined);
    if (key !== undefined) locks.dropFile(key, owner);
  }

  private refuseIfPending(restart: true | undefined): void {
    if (restart && this.options.hasPending?.()) throw new KernelError('EINTR');
  }

  private async procWait(
    req: Extract<WasmSyscall, { op: 'proc-wait' }>,
    cancelled: AbortSignal
  ): Promise<[number, number]> {
    const flags = {
      untraced: req.untraced,
      continued: req.continued,
      inGroup: this.waitGroup(req.pid),
    };
    if (this.owed && !req.nohang) {
      const now = await this.children.wait(req.pid, true, this.interrupt.signal, flags);
      if (now[0] !== 0) return now;
    }
    const signal = req.nohang ? this.interrupt.signal : this.blockingSignal(cancelled);
    const waited = await this.children.wait(req.pid, req.nohang, signal, flags);
    return waited;
  }

  private blockingSignal(cancelled: AbortSignal, owing = true): AbortSignal {
    if (owing && this.owed) {
      this.owed = false;
      throw new KernelError('EINTR');
    }
    if (this.options.hasPending?.() || cancelled.aborted) throw new KernelError('EINTR');
    if (owing) this.waiting.add(cancelled);
    if (owing) this.blocks.get(cancelled)?.();
    return this.cancelSignal(cancelled);
  }

  private cancelSignal(cancelled: AbortSignal): AbortSignal {
    return AbortSignal.any([this.interrupt.signal, cancelled]);
  }

  private async read(
    req: Extract<WasmSyscall, { op: 'fd-read' }>,
    cancelled: AbortSignal
  ): Promise<Uint8Array> {
    const file = this.fds.get(req.fd).file;
    const read = req.peek ? file.peek : file.read;
    if (!read) throw new KernelError(req.peek && file.read ? 'EOPNOTSUPP' : 'EBADF');
    if (file.tty) this.checkForeground(file.tty);
    if (file.clipboard) return this.readClipboard(file.clipboard, req, cancelled);

    if (file instanceof EventFd && req.max < EventFd.SIZE) throw new KernelError('EINVAL');
    if (req.max <= 0) return new Uint8Array(0);
    if (file instanceof KernelSocket && file.unconnected) throw new KernelError('ENOTCONN');
    const ready = pollFile(file).readable;
    if (!ready && req.nonblock) throw new KernelError('EAGAIN');
    const signal = ready ? this.interrupt.signal : this.blockingSignal(cancelled);
    return read.call(file, Math.max(0, Math.min(req.max, MAX_READ)), signal);
  }

  private async readClipboard(
    channel: ClipboardChannel,
    req: Extract<WasmSyscall, { op: 'fd-read' }>,
    cancelled: AbortSignal
  ): Promise<Uint8Array> {
    if (channel.access === 'write') throw new KernelError('EBADF');
    if (req.max <= 0) return new Uint8Array(0);
    if (channel.unread) channel.stamp = await this.clipboardStamp();
    const signal = channel.settled ? this.interrupt.signal : this.blockingSignal(cancelled);
    try {
      return await channel.read(Math.min(req.max, MAX_READ), signal);
    } catch (err) {
      await this.clipboardComplaint(err);
      throw err;
    }
  }

  private async clipboardComplaint(err: unknown): Promise<void> {
    const name = this.options.clipboardName;
    if (name === undefined || !(err instanceof KernelError) || err.detail === undefined) return;
    if (err.code !== 'EACCES' && err.code !== 'EIO') return;
    const stderr = this.fds.has(2) ? this.fds.get(2).file : undefined;
    if (!stderr?.write || stderr.clipboard) return;
    const line = `${name}: /dev/clipboard: ${clipboardLine(err.detail)}\n`;
    const timeout = new Promise<0>((r) => setTimeout(() => r(0), 1000));
    await Promise.race([
      stderr.write(new TextEncoder().encode(line), AbortSignal.timeout(1000)).catch(() => 0),
      timeout,
    ]);
  }

  private async write(
    fd: number,
    body: Uint8Array,
    nonblock = false,
    cancelled: AbortSignal
  ): Promise<number> {
    const file = this.fds.get(fd).file;
    if (file.sealed) return file.sealed.send(body, await this.sealedCaller(), this.gone.signal);
    if (!file.write) throw new KernelError('EBADF');
    if (!pollFile(file).writable) {
      if (nonblock) throw new KernelError('EAGAIN');
      return file.write(body, this.blockingSignal(cancelled));
    }

    if (nonblock) return file.write(body, AbortSignal.abort());

    return file.write(
      body,
      this.options.hasPending?.() ? AbortSignal.abort() : this.cancelSignal(cancelled)
    );
  }

  private async openVfs(
    req: Extract<FdSyscall, { op: 'fd-open-vfs' }>,
    cancelled: AbortSignal
  ): Promise<number> {
    if (inProc(req.path)) return this.openProc(req, req.path);
    const device = req.orphan ? undefined : deviceAt(req.path);
    if (device) return this.openDevice(req, device);
    const alias = req.orphan
      ? undefined
      : await procAlias(this.options.fs, req.path, !req.exclusive);
    if (typeof alias === 'object')
      throw Object.assign(new Error(alias.refused), { code: alias.refused });
    if (alias !== undefined) return this.openProc(req, alias);
    await refuseReadonly(this.options.fs, req.path, req.flags, req);
    if (this.writesAt(req)) await this.options.fs.mayChange?.(req.path, !req.exclusive);
    await this.mayOpen(req);
    if (req.fifo && !req.exclusive) {
      const opened = await this.openFifo(req, cancelled);
      if (opened !== undefined) return opened;
    }
    const marked = await this.markedPath(req);
    await this.sourceOpen(marked === undefined ? req : { ...req, path: marked });
    const fs = marked === undefined ? this.options.fs : (this.options.noLinks as KernelFs);
    const fd = this.fds.install(heldFile(), 3);
    try {
      const nodes = this.nodes;
      const gen = this.replacements?.generation() ?? 0;
      const path = await this.openPath(req, marked);
      if (inProc(path)) {
        this.fds.installAt(fd, await this.procFile(req, path));
        return fd;
      }
      if (this.writesAt(req) && this.options.readonlyAt?.(path)) throw new KernelError('EROFS');
      const open = { ...req, path };
      const plain = this.plainMode(req.mode);
      if (req.exclusive) {
        await nodes.createExclusive(path, this.newOwner(req.mode));
        if (plain !== undefined) await fs.chmod?.(path, plain);
        this.fds.installAt(fd, this.openVfsFile(open, undefined, fs));
      } else if (req.create) {
        await nodes.onEntry(path, async () => {
          const marks = this.options.owners || plain !== undefined;
          const fresh = marks && !(await present(fs, path, true));
          this.fds.installAt(fd, this.openVfsFile(open, await nodes.identify(path), fs));
          await this.fds.get(fd).file.stat?.();
          if (fresh && plain !== undefined) await fs.chmod?.(path, plain);
          else if (fresh) {
            await fs.chown?.(path, { ...this.newOwner(req.mode), kind: 'new' });
          }
        });
      } else {
        await this.unmissed(
          () => this.openPath(req, marked),
          async (at) => {
            await this.stillOpen(at, req.handle);
            return nodes.identify(at);
          },
          (id, at) => this.fds.installAt(fd, this.openVfsFile({ ...open, path: at }, id, fs)),
          { at: path, gen }
        );
      }
      if (req.existing && !(await present(fs, path, true))) {
        throw new KernelError('ENOENT');
      }
    } catch (err) {
      await Promise.resolve(this.fds.close(fd));
      throw err;
    }
    return fd;
  }

  private async openFifo(
    req: Extract<FdSyscall, { op: 'fd-open-vfs' }>,
    cancelled: AbortSignal
  ): Promise<number | undefined> {
    const fifos = this.options.fifos;
    const path = await this.nodes.targetKey(req.path);
    const st = await (this.heldFs() as KernelFs).stat(path);
    if (!st.isFifo) return undefined;
    if (!fifos) throw new KernelError('ENXIO');
    const access = openAccess(req.flags);
    const nonblock = (req.flags & O_NONBLOCK) !== 0;
    const blocks = !nonblock && access !== 'both';
    const signal = blocks ? this.blockingSignal(cancelled) : cancelled;
    const end = await fifos.open(`${st.dev ?? 0}:${st.ino}`, path, access, nonblock, signal);
    return this.fds.install(end, 3);
  }

  private openDevice(
    req: Extract<FdSyscall, { op: 'fd-open-vfs' }>,
    device: NonNullable<ReturnType<typeof deviceAt>>
  ): number {
    if (req.exclusive) throw Object.assign(new Error(req.path), { code: 'EEXIST' });
    const access = req.flags & WRITE_ACCESS;
    return this.fds.install(
      deviceFile(device, access === 0 ? 'read' : access === 1 ? 'write' : undefined),
      3
    );
  }

  private async identified(
    stat: () => Promise<{ path: string; size: number; orphan?: true }>,
    known?: () => number | undefined
  ): Promise<{ path: string; size: number; orphan?: true; ino?: number }> {
    const first = await stat();
    if (first.orphan) return first;
    const ino = known?.();
    if (ino !== undefined) return { ...first, ino };
    const { fs } = this.options;
    const look = async () => {
      const now = await stat();
      if (now.path !== first.path || now.orphan) return now;
      const st = await fs.stat?.(now.path).catch(() => undefined);
      return st?.ino === undefined ? now : { ...now, ino: st.ino };
    };
    return fs.exclusive ? fs.exclusive(first.path, look) : look();
  }

  private writesAt(req: Extract<FdSyscall, { op: 'fd-open-vfs' }>): boolean {
    return (
      (req.flags & WRITE_ACCESS) !== 0 ||
      req.truncate === true ||
      req.create === true ||
      req.exclusive === true
    );
  }

  private async sourceOpen(req: Extract<FdSyscall, { op: 'fd-open-vfs' }>): Promise<void> {
    const { source } = this.options;
    const inherited = req.orphan || req.contents !== undefined || req.handle !== undefined;
    if (!source || inherited || req.pin !== undefined || req.exclusive) return;
    await source.open(req.path);
  }

  private async markedPath(
    req: Extract<FdSyscall, { op: 'fd-open-vfs' }>
  ): Promise<string | undefined> {
    const { guard, noLinks } = this.options;
    const inherited = req.orphan || req.contents !== undefined || req.handle !== undefined;
    if (guard?.links === undefined || !noLinks || inherited || req.pin !== undefined)
      return undefined;
    return (await walk(guard.fs, this.cred, req.path, !req.exclusive, guard.links)).path;
  }

  private async openPath(
    req: Extract<FdSyscall, { op: 'fd-open-vfs' }>,
    marked: string | undefined
  ): Promise<string> {
    const nodes = this.nodes;
    if (req.orphan) return req.path;
    if (req.exclusive) return nodes.entryKey(marked ?? req.path);
    if (marked !== undefined) return marked;
    if (req.create) return nodes.targetKey(req.path);
    return this.keptOr(await nodes.targetKey(req.path), req.handle);
  }

  private async mayOpen(req: Extract<FdSyscall, { op: 'fd-open-vfs' }>): Promise<void> {
    const { guard } = this.options;
    const inherited = req.orphan || req.contents !== undefined || req.handle !== undefined;
    if (!guard || inherited || req.pin !== undefined) return;
    const g = { fs: guard.fs, dac: guard.dac, cred: this.cred, pid: this.pid, links: guard.links };
    if (req.exclusive) return inParent(g, 'open', req.path);
    if (req.created && guard.created?.take(req.path)) return;
    const access = req.flags & WRITE_ACCESS;
    const want = (access === 1 ? 0 : R_OK) | (access !== 0 || req.truncate ? W_OK : 0);
    await openable(g, 'open', req.path, want, req.create === true);
  }

  private openTty(name: string | undefined): number {
    const tty =
      name === undefined ? this.controllingTerminal() : this.options.jobs?.terminalNamed(name);
    if (!tty) throw new KernelError('ENXIO');
    if (name !== undefined) ttyOpenable(this.guarded(), tty);
    const file = tty.file();
    return this.fds.install(this.options.outputFilter?.(file) ?? file, 3);
  }

  private openSealed(flags: number): number {
    const broker = this.options.sealed;
    if (!broker) throw new KernelError('ENOENT');
    return this.fds.install(broker.open(openAccess(flags)), 3);
  }

  private async openClipboard(flags: number): Promise<number> {
    const broker = this.options.clipboard;
    if (!broker) throw new KernelError('ENOENT');
    const file = broker.open(openAccess(flags), await this.clipboardStamp());
    return this.fds.install(this.options.outputFilter?.(file) ?? file, 3);
  }

  private async clipboardStamp(): Promise<ClipboardStamp> {
    const shown = await this.options.identity?.();
    const broker = this.options.clipboard as ClipboardBroker;
    const tag = broker.tagOf(this.pid);
    return {
      pid: shown?.pid ?? this.pid,
      uid: this.cred.euid,
      gid: this.cred.egid,
      users: broker.users,
      ...(tag !== undefined ? { tag } : {}),
    };
  }

  private async stampClipboards(): Promise<void> {
    if (!this.options.clipboard) return;
    const open = this.fds.numbers().filter((fd) => this.fds.get(fd).file.clipboard);
    if (open.length === 0) return;
    const stamp = await this.clipboardStamp().catch(() => undefined);
    if (!stamp) return;
    for (const fd of open) {
      const channel = this.fds.get(fd).file.clipboard;
      if (channel) channel.stamp = stamp;
    }
  }

  connectorStamp(): Promise<SealedCaller> {
    return this.sealedCaller();
  }

  private async sealedCaller(): Promise<SealedCaller> {
    const shown = await this.options.identity?.();
    const broker = this.options.sealed as SealedBroker;
    const ids = { pid: shown?.pid ?? this.pid, ppid: shown?.ppid ?? 0 };
    return broker.stamp(ids, this.cred, broker.tagOf(this.pid));
  }

  private guarded(): Guard | undefined {
    const { guard } = this.options;
    return (
      guard && { fs: guard.fs, dac: guard.dac, cred: this.cred, pid: this.pid, links: guard.links }
    );
  }

  private ttyOwner(): Perm {
    return { uid: this.cred.euid, gid: this.cred.egid, mode: TTY_MODE };
  }

  private terminalByName(name: string): KernelTty {
    const n = ptsNumber(name);
    const tty =
      n === undefined ? this.options.jobs?.terminalNamed(name) : this.options.ptys?.get(n).slave;
    if (!tty) throw new KernelError('ENOENT');
    return tty;
  }

  private plainMode(mode: number | undefined): number | undefined {
    if (this.options.owners || mode === undefined) return undefined;
    const wanted = mode & 0o7777 & ~this.umask;
    return wanted === PLAIN_FILE_MODE ? undefined : wanted;
  }

  private newOwner(mode = 0o666): NewOwner | undefined {
    if (!this.options.owners) return undefined;
    return { uid: this.cred.euid, gid: this.cred.egid, mode: mode & 0o7777 & ~this.umask };
  }

  private async openProc(
    req: Extract<FdSyscall, { op: 'fd-open-vfs' }>,
    path: string
  ): Promise<number> {
    return this.fds.install(await this.procFile(req, path), 3);
  }

  private async procFile(
    req: Extract<FdSyscall, { op: 'fd-open-vfs' }>,
    path: string
  ): Promise<OpenFile> {
    if (req.flags & WRITE_ACCESS || req.create || req.truncate || req.exclusive) {
      throw new KernelError('EROFS');
    }
    const tree = new ProcTree(
      {
        procList: () => this.options.processes?.() ?? { boot: 0, processes: [] },
        mountList: () => this.options.mounts?.() ?? [],
      },
      (await this.options.identity?.())?.pid ?? this.pid
    );
    return memoryFile(tree.read(path), path, req.position);
  }

  private openVfsFile(
    req: Extract<FdSyscall, { op: 'fd-open-vfs' }>,
    id?: string,
    fs = this.options.fs
  ): OpenFile {
    return vfsFile(
      fs,
      {
        path: req.path,
        flags: req.flags,
        position: req.position,
        ...(req.contents !== undefined ? { contents: req.contents } : {}),
        ...(req.orphan ? { orphan: true } : {}),
        ...(req.truncate ? { truncate: true } : {}),
        ...(req.create ? { create: true } : {}),
        ...(req.pin ? { pin: req.pin } : {}),
        ...(id !== undefined && !req.orphan ? { id } : {}),
        ...(req.ino !== undefined && !req.orphan ? { ino: req.ino } : {}),
      },
      this.nodes
    );
  }

  private async fdSyscall(req: FdSyscall, cancelled: AbortSignal): Promise<SyncFsResult> {
    if (isVfsSyscall(req)) return this.vfsSyscall(req);
    switch (req.op) {
      case 'fd-read':
        return { ok: true, kind: 'bytes', bytes: await this.read(req, cancelled) };
      case 'fd-write':
        return {
          ok: true,
          kind: 'json',
          json: await this.write(req.fd, req.body, req.nonblock, cancelled),
        };
      case 'fd-close': {
        this.options.locks?.closed(this.pid, req.fd);
        await this.dropRecordLocks(req.fd);
        const channel = this.fds.get(req.fd).file.clipboard;
        if (channel) channel.stamp = await this.clipboardStamp();
        await Promise.resolve(this.fds.close(req.fd)).catch(async (err: unknown) => {
          if (channel) await this.clipboardComplaint(err);
          throw err;
        });
        return { ok: true, kind: 'void' };
      }
      case 'fd-pipe': {
        const pipe = openPipe();
        const read = this.fds.install(pipe.read, 3);
        let write: number;
        try {
          write = this.fds.install(pipe.write, 3);
        } catch (e) {
          await Promise.resolve(this.fds.close(read));
          throw e;
        }
        return { ok: true, kind: 'json', json: [read, write] };
      }
      case 'fd-poll':
        return { ok: true, kind: 'json', json: pollFile(this.fds.get(req.fd).file) };
      case 'fd-open-vfs':
        return { ok: true, kind: 'json', json: await this.openVfs(req, cancelled) };
      case 'fd-info':
        return { ok: true, kind: 'json', json: this.fdInfo(req.fd) };
      case 'fd-list':
        return {
          ok: true,
          kind: 'json',
          json: this.fds.numbers().map((fd) => ({ fd, ...this.fdInfo(fd) })),
        };
      case 'fd-meta': {
        if (!this.fds.get(req.fd).file.held) throw new KernelError('EBADF');
        const cloexec = this.fds.closesOnExec(req.fd);
        this.fds.installAt(req.fd, heldFile(req.meta));
        if (cloexec) this.fds.setCloseOnExec(req.fd);
        return { ok: true, kind: 'void' };
      }
      case 'fd-setfl':
        this.fds.setStatusFlags(req.fd, req.flags);
        return { ok: true, kind: 'void' };
      case 'fd-cloexec':
        if (req.on) this.fds.setCloseOnExec(req.fd);
        else this.fds.clearCloseOnExec(req.fd);
        return { ok: true, kind: 'void' };
      case 'fd-dup':
        return { ok: true, kind: 'json', json: this.fds.dup(req.fd, req.min ?? 3) };
      case 'fd-reserve':
        return { ok: true, kind: 'json', json: this.reserve(req.fd, req.min, req.meta) };
      case 'fd-promote':
        await this.promote(req);
        return { ok: true, kind: 'void' };
      case 'fd-renumber':
        if (req.from !== req.to) {
          await this.fds.dup2Clipboard(req.from, req.to);
          if (!req.keep) await Promise.resolve(this.fds.close(req.from));
        }
        return { ok: true, kind: 'void' };
      case 'fd-open-tty':
        return { ok: true, kind: 'json', json: this.openTty(req.name) };
      case 'fd-tty-names':
        return { ok: true, kind: 'json', json: this.options.jobs?.terminalNames() ?? [] };
      case 'fd-open-sealed':
        return { ok: true, kind: 'json', json: this.openSealed(req.flags) };
      case 'fd-open-clipboard':
        return { ok: true, kind: 'json', json: await this.openClipboard(req.flags) };
      case 'fd-clipboard-abort': {
        const file = this.fds.get(req.fd);
        file.file.clipboard?.abort();
        return { ok: true, kind: 'void' };
      }
      case 'fd-tty-owner':
        return { ok: true, kind: 'json', json: this.terminalByName(req.name).owner ?? null };
      case 'fd-select': {
        const { read, write, timeoutMs } = req;
        if (this.owed && timeoutMs !== 0) {
          const ready = await selectFds(this.fds, read, write, 0, this.interrupt.signal);
          if (ready.read.length + ready.write.length > 0)
            return { ok: true, kind: 'json', json: ready };
        }
        const signal = this.blockingSignal(cancelled, timeoutMs !== 0);
        const selected = await selectFds(this.fds, read, write, timeoutMs, signal);
        return { ok: true, kind: 'json', json: selected };
      }
      case 'fd-seek': {
        const file = this.fds.get(req.fd).file;
        if (!file.seek) throw new KernelError('ESPIPE');
        return { ok: true, kind: 'json', json: await file.seek(req.offset, req.whence) };
      }
      case 'fd-flush': {
        const file = this.fds.get(req.fd).file;
        if (file.flush) await file.flush();
        return { ok: true, kind: 'void' };
      }
    }
  }

  private async vfsSyscall(req: VfsSyscall): Promise<SyncFsResult> {
    if ('path' in req || 'from' in req) {
      const nodes = this.nodes;
      if (req.op === 'fd-path-flush') {
        await nodes.flush(await nodes.targetKey(req.path).catch(() => req.path));
      } else if (req.op === 'fd-path-unlinking')
        await nodes.unlinking(await nodes.entryKey(req.path));
      else if (req.op === 'fd-path-unlinked') nodes.unlinked(await nodes.entryKey(req.path));
      else if (req.op === 'fd-path-renamed') {
        nodes.renamed(await nodes.entryKey(req.from), await nodes.entryKey(req.to));
      }
      return { ok: true, kind: 'void' };
    }
    const file = this.fds.get(req.fd).file;
    if (!file.pread || !file.pwrite || !file.resize || !file.stat) throw new KernelError('ESPIPE');
    switch (req.op) {
      case 'fd-pread':
        return {
          ok: true,
          kind: 'bytes',
          bytes: await file.pread(Math.min(req.max, MAX_READ), req.offset),
        };
      case 'fd-pwrite':
        return { ok: true, kind: 'json', json: await file.pwrite(req.body, req.offset) };
      case 'fd-resize':
        await file.resize(req.size);
        return { ok: true, kind: 'void' };
      case 'fd-vfs-stat': {
        if (req.identity) {
          return {
            ok: true,
            kind: 'json',
            json: await this.identified(file.stat.bind(file), file.known?.bind(file)),
          };
        }
        const vfs = await file.stat();
        if (!req.full) return { ok: true, kind: 'json', json: vfs };
        const st = await this.heldStat(vfs).catch(() => undefined);
        return { ok: true, kind: 'json', json: { ...vfs, ...(st ? { stat: st } : {}) } };
      }
      case 'fd-chmod':
      case 'fd-chown':
      case 'fd-utimes':
        return this.fdMetadata(await file.stat(), req);
    }
  }

  keptPath?: (path: string) => string | undefined;

  async holds(path: string): Promise<boolean> {
    for (const fd of this.fds.numbers()) {
      const { file } = this.fds.get(fd);
      if ((await file.stat?.().catch(() => undefined))?.path === path) return true;
    }
    return false;
  }

  keptHandle?: (handle: number) => string | undefined;

  holdsHandle?: (handle: number) => boolean;

  replacements?: Replacements;

  private async unmissed<T, R>(
    path: () => Promise<string>,
    look: (at: string) => Promise<T>,
    make: (found: T, at: string) => R,
    first?: { at: string; gen: number }
  ): Promise<R> {
    let given = first;
    for (;;) {
      const r = this.replacements;
      const gen = given?.gen ?? r?.generation() ?? 0;
      const at = given?.at ?? (await path());
      given = undefined;
      await r?.settled(at);
      const found = await look(at);
      if (!r || (!r.missed(at) && !r.changedSince(at, gen))) return make(found, at);
    }
  }

  private async stillOpen(at: string, handle: number | undefined): Promise<void> {
    if (handle === undefined || this.keptHandle?.(handle) !== undefined) return;
    if (this.holdsHandle?.(handle) !== false) return;
    if (!(await present(this.options.fs, at, true))) throw new KernelError('ENOENT');
  }

  private async keptOr(path: string, handle?: number): Promise<string> {
    if (handle !== undefined) return this.keptHandle?.(handle) ?? path;
    const kept = this.keptPath?.(path);
    return kept !== undefined && !(await present(this.options.fs, path, true)) ? kept : path;
  }

  private async promote(req: Extract<WasmSyscall, { op: 'fd-promote' }>): Promise<void> {
    if (!this.fds.get(req.fd).file.held) throw new KernelError('EBADF');
    if (req.share !== undefined) {
      await this.fds.dup2Clipboard(req.share, req.fd);
      return;
    }
    const asked = req.path;
    if (asked === undefined) throw new KernelError('EINVAL');
    const install = ([path, id]: readonly [string, string | undefined]) => {
      if (!this.fds.get(req.fd).file.held) throw new KernelError('EBADF');
      const file = vfsFile(
        this.options.fs,
        {
          path,
          flags: req.flags ?? 0,
          position: req.position ?? 0,
          ...(req.contents !== undefined ? { contents: req.contents } : {}),
          ...(req.orphan ? { orphan: true } : {}),
          ...(req.dirty ? { dirty: true } : {}),
          ...(req.pin ? { pin: req.pin } : {}),
          ...(id !== undefined ? { id } : {}),
          ...(req.ino !== undefined && path === asked ? { ino: req.ino } : {}),
        },
        this.nodes
      );
      this.fds.installAt(req.fd, file);
    };
    if (req.orphan) return install([asked, undefined]);
    await this.unmissed(
      () => this.nodes.targetKey(asked),
      async (target) => {
        const at = await this.keptOr(target, req.handle);
        await this.stillOpen(at, req.handle);
        return [at, await this.nodes.identify(at)] as const;
      },
      install
    );
  }

  private reserve(fd: number | undefined, min = 3, meta?: HeldMeta): number {
    if (fd === undefined) return this.fds.install(heldFile(meta), Math.max(3, min));
    if (this.fds.has(fd)) throw new KernelError('EBADF');
    this.fds.installAt(fd, heldFile(meta));
    return fd;
  }

  private heldPath(vfs: { path?: string; orphan?: boolean }): string {
    if (!vfs.path) throw new KernelError('EBADF');
    if (vfs.orphan) throw new KernelError('EOPNOTSUPP');
    return vfs.path;
  }

  private heldFs(): Partial<KernelFs> {
    return this.options.guard?.fs ?? (this.options.fs as Partial<KernelFs>);
  }

  private async heldStat(vfs: { path?: string; orphan?: boolean }): Promise<FsStat> {
    const stat = this.heldFs().stat;
    if (!stat) throw new KernelError('ENOSYS');
    return stat.call(this.heldFs(), this.heldPath(vfs));
  }

  private async fdMetadata(
    vfs: { path?: string; orphan?: boolean },
    req: Extract<VfsSyscall, { op: 'fd-chmod' | 'fd-chown' | 'fd-utimes' }>
  ): Promise<SyncFsResult> {
    const path = this.heldPath(vfs);
    const fs = this.heldFs();
    const g = this.guarded();
    if (req.op === 'fd-chown') {
      const ids = {
        ...(req.uid !== undefined ? { uid: req.uid } : {}),
        ...(req.gid !== undefined ? { gid: req.gid } : {}),
      };
      if (!this.options.owners || !fs.chown || !fs.stat) await this.heldStat(vfs);
      else await chownAs(fs as KernelFs, this.cred, path, { ...ids, follow: true });
      return { ok: true, kind: 'void' };
    }
    const st = await this.heldStat(vfs);
    if (req.op === 'fd-chmod') {
      if (!fs.chmod) throw new KernelError('ENOSYS');
      await fs.chmod(path, g ? heldChmodMode(g, path, st, req.mode) : req.mode);
      return { ok: true, kind: 'void' };
    }
    if (!fs.utimes) throw new KernelError('ENOSYS');
    if (g) heldRetimable(g, path, st, req.now === true);
    const at = (ms: number | null, kept: Date) =>
      ms === null ? kept : req.now ? new Date() : new Date(ms);
    const atime = at(req.atimeMs, st.atime);
    const mtime = at(req.mtimeMs, st.mtime);
    await fs.utimes(path, atime, mtime);
    return { ok: true, kind: 'void' };
  }

  private fdInfo(fd: number): FdInfo {
    const file = this.fds.get(fd).file;
    const flags = this.fds.statusFlags(fd);
    const terminal = (file.tty ?? file.pty?.slave)?.name;
    return {
      tty: file.tty !== undefined,
      kind: file instanceof KernelSocket || isDatagram(file) ? 'socket' : kernelFdKind(file),
      ...(isDatagram(file) ? { dgram: true as const } : {}),
      ...(file.heldMeta ? { meta: file.heldMeta } : {}),
      ...(flags !== undefined ? { flags } : {}),
      ...(this.fds.closesOnExec(fd) ? { cloexec: true } : {}),
      ...(file.read && !file.write ? { access: 'read' as const } : {}),
      ...(file.write && !file.read ? { access: 'write' as const } : {}),
      ...(file.tty?.name ? { name: file.tty.name } : file.pty ? { name: '/dev/ptmx' } : {}),
      ...(terminal ? { terminal } : {}),
      ...(file.fifo !== undefined ? { fifo: file.fifo } : {}),
    };
  }

  private ttySyscall(req: TtySyscall): SyncFsResult {
    const tty = this.tty(req.fd);
    const jobs = this.options.jobs;
    switch (req.op) {
      case 'tty-get':
        return { ok: true, kind: 'json', json: tty.tcgets() };
      case 'tty-set':
        tty.tcsets(req.termios, req.flush === true);
        return { ok: true, kind: 'void' };
      case 'tty-winsz': {
        const size = tty.winsize();
        this.sizesRead.set(tty, sizeKey(...size));
        return { ok: true, kind: 'json', json: size };
      }
      case 'tty-pgrp-get':
        return { ok: true, kind: 'json', json: jobs ? jobs.tcgetpgrp(tty, this.sid()) : this.pid };
      case 'tty-pgrp-set':
        if (jobs) jobs.tcsetpgrp(this.pid, tty, req.pgrp, this.options.settling?.() ?? false);
        else if (req.pgrp !== this.pid) throw new KernelError('EPERM');
        return { ok: true, kind: 'void' };
    }
  }

  private checkForeground(tty: KernelTty): void {
    const jobs = this.options.jobs;
    if (!jobs) return;
    const session = jobs.controllingTerminal(this.pid);
    if (session !== undefined && session !== tty) return;
    const pgid = this.pgid();
    if (jobs.tcgetpgrp(tty, this.sid()) === pgid) return;
    if (this.ignores(sigbit(SIG.TTIN))) throw new KernelError('EIO');
    jobs.killGroup(pgid, SIG.TTIN);
    throw new KernelError('EINTR');
  }

  private waitGroup(pid: number): ((child: number) => boolean) | undefined {
    const jobs = this.options.jobs;
    if (!jobs || pid > 0 || pid === -1) return undefined;
    const group = pid === 0 ? this.pgid() : -pid;

    return (child) => (jobs.pgidOf(child) ?? this.pgid()) === group;
  }

  private pgid(): number {
    return this.options.jobs?.getpgid(this.pid, 0) ?? this.pid;
  }

  private sid(): number {
    return this.options.jobs?.getsid(this.pid, 0) ?? this.pid;
  }

  private controllingTerminal(): KernelTty | undefined {
    const session = this.options.jobs?.controllingTerminal(this.pid);
    return session === undefined ? this.fds.stdioTerminal() : (session ?? undefined);
  }

  private jobSyscall(req: JobSyscall): SyncFsResult {
    const jobs = this.options.jobs;
    const self = (pid: number): number => {
      if (pid !== 0 && pid !== this.pid) throw new KernelError('ESRCH');
      return this.pid;
    };
    switch (req.op) {
      case 'proc-setpgid':
        if (jobs) jobs.setpgid(this.pid, req.pid, req.pgid);
        else if (self(req.pid) !== (req.pgid || this.pid)) throw new KernelError('EPERM');
        return { ok: true, kind: 'void' };
      case 'proc-getpgid':
        return { ok: true, kind: 'json', json: jobs?.getpgid(this.pid, req.pid) ?? self(req.pid) };
      case 'proc-getsid':
        return { ok: true, kind: 'json', json: jobs?.getsid(this.pid, req.pid) ?? self(req.pid) };
      case 'proc-setsid':
        if (!jobs) throw new KernelError('EPERM');
        return { ok: true, kind: 'json', json: jobs.setsid(this.pid) };
    }
  }

  private httpSyscall(req: HttpSyscall): Promise<SyncFsResult> {
    const http = this.options.http;
    if (!http) return Promise.resolve({ ok: false, errno: 'ENETUNREACH', message: NO_TRANSPORT });
    return http.syscall(req);
  }

  private semSyscall(req: SemSyscall, cancelled: AbortSignal): Promise<SyncFsResult> {
    const g = this.guarded();
    const known = this.fds.handles;
    const handles = known instanceof SemHandles ? known : new SemHandles();
    this.fds.handles = handles;
    return semSyscall(req, {
      table: this.options.sems,
      handles,
      cred: this.cred,
      denied: g ? (op, path) => deny(g, op, path) : undefined,
      umask: this.umask,
      blocking: () => this.blockingSignal(cancelled),
    });
  }

  private socketSyscall(req: SocketSyscall, cancelled: AbortSignal): Promise<SyncFsResult> {
    this.net ??= this.options.net ?? new LoopbackNet();
    const resolver = this.options.resolver ?? HOSTS_ONLY;
    return socketSyscall(req, {
      fds: this.fds,
      net: this.net,
      blocking: () => this.blockingSignal(cancelled),
      resolve: (name, family, blocking) => resolver.resolve(name, family, blocking),
      cred: () => ({ pid: this.pid, uid: this.cred.euid, gid: this.cred.egid }),
      stamp: () => this.connectorStamp(),
      sealed: this.options.sealed,
      names: socketNames({
        fs: this.heldFs() as KernelFs,
        guard: () => this.guarded(),
        create: (path, owner) => this.nodes.createExclusive(path, owner),
        owner: () => ({
          uid: this.cred.euid,
          gid: this.cred.egid,
          mode: 0o777 & ~this.umask,
          socket: true,
        }),
        owners: this.options.owners === true,
      }),
    });
  }

  private tty(fd: number): KernelTty {
    const file = this.fds.get(fd).file;
    const tty = file.tty ?? file.pty?.slave;
    if (!tty) throw new KernelError('ENOTTY');
    return tty;
  }

  private async procSyscall(
    req: Exclude<
      WasmSyscall,
      | FdSyscall
      | TtySyscall
      | JobSyscall
      | SocketSyscall
      | EpollSyscall
      | SemSyscall
      | HttpSyscall
      | PtySyscall
      | HostSyscall
      | WatchSyscall
    >,
    cancelled: AbortSignal
  ): Promise<SyncFsResult> {
    switch (req.op) {
      case 'proc-fork':
        this.refuseIfPending(req.restart);
        return { ok: true, kind: 'json', json: await this.children.fork(this.withDl(req.state)) };
      case 'proc-spawn':
        this.refuseIfPending(req.restart);
        return { ok: true, kind: 'json', json: await this.spawn(req) };
      case 'proc-wait':
        return { ok: true, kind: 'json', json: await this.procWait(req, cancelled) };
      case 'proc-run':
        return { ok: true, kind: 'bytes', bytes: await this.run(req) };
      case 'proc-exit':
        if (!this.options.exitNow) throw new KernelError('ENOSYS');
        this.options.exitNow(req.status & 0xff);
        return DYING;
      case 'proc-kill-self':
        return this.selfKill(req);
      case 'proc-identity':
        return { ok: true, kind: 'json', json: (await this.options.identity?.()) ?? null };
      case 'proc-exec': {
        this.blocks.get(cancelled)?.();
        this.adoptExec(req.pid);
        this.options.jobs?.exec(this.pid, req.pid);

        await this.fds.closeAll();
        try {
          const waited = await this.children.wait(req.pid, false);
          const termsig = waited[1] & 0x7f;
          if (termsig) this.execTermsig = termsig;
          return { ok: true, kind: 'json', json: waited };
        } finally {
          this.execChild = undefined;
        }
      }
      case 'proc-kill':
        if (req.sig !== 0 && !isSignal(req.sig)) throw new KernelError('EINVAL');

        if (!(await this.options.kill?.(req.pid === 0 ? -this.pgid() : req.pid, req.sig))) {
          throw new KernelError('ESRCH');
        }
        return { ok: true, kind: 'void' };
      case 'proc-list':
        return {
          ok: true,
          kind: 'json',
          json: this.options.processes?.() ?? { boot: 0, processes: [] },
        };
      case 'mount-list':
        return { ok: true, kind: 'json', json: this.options.mounts?.() ?? [] };
      case 'mount':
      case 'umount':
        return this.mountSyscall(req, cancelled);
      case 'proc-alarm':
        this.setAlarm(req.sig, req.firstMs ?? req.ms, req.repeat ? req.ms : 0, req.timer);
        return { ok: true, kind: 'void' };
      case 'proc-umask':
        return { ok: true, kind: 'json', json: this.setUmask(req.mask) };
      case 'proc-cred':
        return { ok: true, kind: 'json', json: copyCred(this.cred) };
      case 'proc-setcred':
        this.cred = changeCred(this.cred, req.change);
        return { ok: true, kind: 'json', json: copyCred(this.cred) };
      case 'dl-log':
        if (req.append) this.dlLog.push(req.append);
        return { ok: true, kind: 'json', json: this.dlLog.slice(req.from) };
      case 'dl-closure':
        return { ok: true, kind: 'json', json: this.allocateClosure(req.floor) };
      case 'dl-closure-free':
        this.freeClosure(req.index);
        return { ok: true, kind: 'void' };
      case 'dl-reserve':
        return { ok: true, kind: 'json', json: this.reserveSlots(req.floor, req.size) };
      case 'dl-load-reserve':
        return {
          ok: true,
          kind: 'json',
          json: { base: this.reserveSlots(req.floor, req.size), handle: this.closures.handle++ },
        };
      case 'dl-lock':
        await this.lockDl(req.owner);
        return { ok: true, kind: 'void' };
      case 'dl-unlock':
        this.unlockDl(req.owner);
        return { ok: true, kind: 'void' };
      case 'sig-waiting':
        this.setSigwaiter(req.tid, req.set);
        return { ok: true, kind: 'void' };
      case 'sig-mask':
      case 'sig-inherited':
        return this.signalSyscall(req);
      case 'sig-pause':
        return this.pause(cancelled);
      case 'thread-kill':
        await this.threadKill(req.tid, req.sig);
        return { ok: true, kind: 'void' };
      case 'sig-info':
        return { ok: true, kind: 'json', json: this.takeSigInfo(req.sig, req.tid ?? 0) };
      case 'proc-captured':
        return { ok: true, kind: 'bytes', bytes: this.children.captured(req.pid, req.slot) };
      case 'proc-sudo':
        return { ok: true, kind: 'json', json: await this.sudo(req, cancelled) };
      case 'proc-crontab':
        return { ok: true, kind: 'json', json: await this.crontab(req) };
    }
  }

  private async crontab(req: CrontabCall): Promise<CrontabResult> {
    const { crontab } = this.options;
    if (!crontab) throw new KernelError('ENOSYS');
    const call = crontabCall(req);
    if (!call) throw new KernelError('EINVAL');
    return crontab(call);
  }

  private signalSyscall(
    req: Extract<WasmSyscall, { op: 'sig-mask' | 'sig-inherited' }>
  ): SyncFsResult {
    if (req.op === 'sig-inherited') {
      return { ok: true, kind: 'json', json: this.inherited & ~this.caught };
    }
    this.caught = req.caught;
    this.ignored = req.ignored;
    this.inherited &= ~(req.defaults ?? 0);
    this.nocldwait = req.nocldwait === true;
    return { ok: true, kind: 'void' };
  }

  private reapsChildren(): boolean {
    return this.nocldwait || this.ignores(sigbit(SIG.CHLD));
  }

  private async sudo(req: SudoCall, cancelled: AbortSignal): Promise<unknown> {
    const { sudo } = this.options;
    if (!sudo) throw new KernelError('ENOSYS');
    const call: SudoCall = {
      op: 'proc-sudo',
      args: words(req.args),
      cwd: typeof req.cwd === 'string' && req.cwd.startsWith('/') ? req.cwd : '/',
      ...(typeof req.term === 'string' ? { term: req.term } : {}),
    };
    const answer = await sudo(call, this.blockingSignal(cancelled));
    if (!('grant' in answer)) return answer;
    if (this.dying) throw new KernelError('EINTR');
    const { file, argv, env, cwd, cred, caller } = answer.grant;
    const stdio = [{ fd: 0 }, { fd: 1 }, { fd: 2 }];
    return {
      pid: await this.children.spawn({ file, argv, env, cwd, pgid: 0 }, stdio, [], {
        cred,
        caller,
      }),
    };
  }

  private async mountSyscall(
    req: Extract<WasmSyscall, { op: 'mount' | 'umount' }>,
    cancelled: AbortSignal
  ): Promise<SyncFsResult> {
    const { mount, umount } = this.options;
    if (!mount || !umount) throw new KernelError('ENOSYS');
    try {
      if (req.op === 'umount') await umount(req.target, req.flags);
      else {
        const { source, target, type, flags, data } = req;
        const signal = this.blockingSignal(cancelled);
        await Promise.race([mount({ source, target, type, flags, data }, signal), aborted(signal)]);
      }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== 'string') throw err;
      return { ok: false, errno: code, message: (err as Error).message };
    }
    return { ok: true, kind: 'void' };
  }

  private pause(cancelled: AbortSignal): Promise<never> {
    return aborted(this.blockingSignal(cancelled));
  }

  private alarm: (() => void) | undefined;
  private readonly dlLog: LinkRecord[] = [];
  private readonly closures = {
    next: 0,
    handle: 1,
    free: [] as number[],
    live: new Set<number>(),
  };

  private withDl(state: ForkState): ForkState {
    if (this.dlLog.length === 0) return state;
    const { next, handle, free, live } = this.closures;
    const dl = { log: [...this.dlLog], next, handle, free: [...free], live: [...live] };
    return { ...state, dl };
  }

  private seedDl(dl: DlState | undefined): void {
    if (!dl) return;
    this.dlLog.push(...dl.log);
    this.closures.next = dl.next;
    this.closures.handle = dl.handle;
    this.closures.free.push(...dl.free);
    for (const index of dl.live) this.closures.live.add(index);
  }

  private allocateClosure(floor: number): number {
    const index = this.closures.free.pop() ?? Math.max(floor, this.closures.next);
    this.closures.next = Math.max(this.closures.next, index + 1);
    this.closures.live.add(index);
    this.dlLog.push({ kind: 'closure', index });
    return index;
  }

  private freeClosure(index: number): void {
    if (!this.closures.live.delete(index)) throw new KernelError('EINVAL');
    this.closures.free.push(index);
    this.dlLog.push({ kind: 'closure-free', index });
  }

  private readonly dlLock = {
    owner: 0,
    depth: 0,
    waiters: new Set<{ owner: number; wake: (gone: boolean) => void }>(),
  };

  private async lockDl(owner: number): Promise<void> {
    while (this.dlLock.depth > 0 && this.dlLock.owner !== owner) {
      if (this.dying) throw new KernelError('EINTR');
      const interrupt = this.interrupt.signal;
      const gone = await new Promise<boolean>((resolve) => {
        const waiter = {
          owner,
          wake: (ended: boolean) => {
            this.dlLock.waiters.delete(waiter);
            interrupt.removeEventListener('abort', recheck);
            resolve(ended);
          },
        };
        const recheck = () => waiter.wake(false);
        this.dlLock.waiters.add(waiter);
        interrupt.addEventListener('abort', recheck, { once: true });
      });
      if (gone) throw new KernelError('EINTR');
    }
    this.dlLock.owner = owner;
    this.dlLock.depth++;
  }

  threadEnded(tid: number): void {
    for (const waiter of [...this.dlLock.waiters]) if (waiter.owner === tid) waiter.wake(true);
    if (this.dlLock.depth === 0 || this.dlLock.owner !== tid) return;
    this.dlLock.depth = 0;
    this.wakeDl();
  }

  private unlockDl(owner: number): void {
    if (this.dlLock.depth === 0 || this.dlLock.owner !== owner) throw new KernelError('EPERM');
    this.dlLock.depth--;
    if (this.dlLock.depth === 0) this.wakeDl();
  }

  private wakeDl(): void {
    for (const waiter of [...this.dlLock.waiters]) waiter.wake(false);
  }

  private reserveSlots(floor: number, size: number): number {
    const base = Math.max(floor, this.closures.next);
    this.closures.next = base + size;
    return base;
  }
  private readonly asyncOps = new AsyncOps(
    (req, cancelled) => this.syscall(req as WasmSyscall, cancelled),
    () => this.options.onAsync?.()
  );

  private setAlarm(sig: number, first: number, every: number, timer?: number): void {
    if (!isSignal(sig)) throw new KernelError('EINVAL');
    this.clearAlarm();
    if (first <= 0) return;
    const fire =
      timer === undefined ? () => this.options.raise?.(sig) : () => this.timerExpired(timer);
    this.alarm = repeating(first, every, fire);
  }

  private timerExpired(which: number): void {
    this.options.onTimer?.(which);
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
  }

  private clearAlarm(): void {
    this.alarm?.();
    this.alarm = undefined;
  }

  async exit(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    this.gone.abort();
    this.die();
    this.clearAlarm();
    this.interrupt.abort();
    this.options.locks?.release(this.pid);
    for (const owner of this.lockOwners) this.options.locks?.release(owner);
    this.asyncOps.close();
    this.watches.closeAll();
    for (const [target, sig] of this.deathSignals) this.sendDeath(target, sig);
    this.deathSignals.clear();
    for (const pid of this.children.pids()) this.options.onReap?.(pid);
    await this.stampClipboards();
    await this.fds.closeAll();
    if (!this.options.nodes) this.options.openFiles?.delete(this.nodes);
    await this.options.http?.closeAll();
  }
}
