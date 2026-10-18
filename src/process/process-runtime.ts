import type { Cred } from '../kernel/cred.ts';
import type { DeviceMeta, HeldMeta, PollState } from '../kernel/fd-table.ts';
import { hostnameOf } from '../kernel/net/loopback-names.ts';
import type { MountLine, ProcessListing } from '../kernel/proc-info.ts';
import {
  type ForkState,
  type InheritedFd,
  WASM_PROCESS_READY,
  type WasmProcessInitMsg,
} from '../kernel/protocol.ts';
import { SIG } from '../kernel/signals.ts';
import type { Termios } from '../kernel/tty.ts';
import { mountVfsIntoEmscripten } from '../realm/emscripten-vfs-hook.ts';
import { type LiveFsNode, liveNodePath } from '../realm/live-vfs-fs.ts';
import { SYNC_FS_OPS, type SyncFsResult } from '../realm/sync-fs-wire.ts';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  lookedOutside,
  type SabPostLike,
  type SyncSabTransport,
} from '../realm/sync-sab-bridge.ts';
import {
  publishMemory,
  SAB_HEADER_I32,
  SAB_I_KILLED,
  SAB_I_SIGNALS,
  SAB_I_STOP,
  SAB_I_TIMERS,
  type SyncSabRequestBody,
} from '../realm/sync-sab-wire.ts';
import {
  KernelStreams,
  type ProcessFs,
  type ProcessPipeFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
  type TtyOwner,
} from './kernel-streams.ts';
import { createProcessKernel, inheritedSignals, type ProcessKernel } from './process-children.ts';
import {
  devCreations,
  type FdImports,
  type GlueSyscalls,
  type KernelImports,
  kernelAccess,
  kernelLink,
  kernelUmask,
  kernelUname,
  linuxDevices,
  type Memalign,
  noFollowUtimes,
  pathOpensLinks,
  positionalIo,
  syncFsync,
  trackCloseOnExec,
  useDevFd,
  useDevRemoval,
  useFifoOpens,
  useFileMmap,
  useMounts,
  useZeroDevices,
  wasmMemory,
  wrapCloexecSyscalls,
  wrapImport,
} from './process-fds.ts';
import {
  describeForFork,
  describeInherited,
  placeKernelStream,
  restoreForkedStreams,
  vfsPromoter,
} from './process-fork.ts';
import { createHttpKernel } from './process-http.ts';
import { closeDropsLocks, kernelFlock, type LockHeld, type LockKernel } from './process-locks.ts';
import type { PtyKernel } from './process-pty.ts';
import { SignalGate } from './process-signals.ts';
import { createSocketKernel } from './process-sockets.ts';
import { type ProcFs, useProcfs } from './procfs.ts';
import { credAbi, type Owner, ownByCaller } from './realm-user.ts';

export {
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.ts';

const FS_OPS: ReadonlySet<string> = new Set(SYNC_FS_OPS);

export function kernelSys(transport: SyncSabTransport): ProcessSys & PtyKernel & LockKernel {
  const call = (req: SyncSabRequestBody, label: string): SyncFsResult => {
    const r = transport.call(req, Number.POSITIVE_INFINITY, label);
    if (!r.ok) throw new SyscallError(r.errno);
    return r;
  };
  const json = (r: SyncFsResult): unknown => (r.ok && r.kind === 'json' ? r.json : undefined);
  return {
    read(fd, max, opts) {
      const flags = {
        ...(opts?.nonblock ? { nonblock: true } : {}),
        ...(opts?.peek ? { peek: true } : {}),
      };
      const r = call({ op: 'fd-read', fd, max, ...flags }, `fd-read ${fd}`);
      return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
    },
    write(fd, bytes, opts) {
      const req = {
        op: 'fd-write' as const,
        fd,
        body: bytes,
        ...(opts?.nonblock ? { nonblock: true } : {}),
      };
      const n = json(call(req, `fd-write ${fd}`));
      return typeof n === 'number' ? n : bytes.length;
    },
    close(fd) {
      call({ op: 'fd-close', fd }, `fd-close ${fd}`);
    },
    pipe() {
      return json(call({ op: 'fd-pipe' }, 'fd-pipe')) as [number, number];
    },
    poll(fd) {
      return json(call({ op: 'fd-poll', fd }, `fd-poll ${fd}`)) as PollState;
    },
    openVfs(path, flags, position, opts) {
      return json(
        call(
          {
            op: 'fd-open-vfs',
            path,
            flags,
            position,
            ...(opts?.contents !== undefined ? { contents: opts.contents } : {}),
            ...(opts?.orphan ? { orphan: true } : {}),
            ...(opts?.truncate ? { truncate: true } : {}),
            ...(opts?.create ? { create: true } : {}),
            ...(opts?.created ? { created: true } : {}),
            ...(opts?.pin ? { pin: opts.pin } : {}),
            ...(opts?.handle !== undefined ? { handle: opts.handle } : {}),
            ...(opts?.ino !== undefined ? { ino: opts.ino } : {}),
            ...(opts?.fifo ? { fifo: true } : {}),
          },
          `fd-open-vfs ${path}`
        )
      ) as number;
    },
    seek(fd, offset, whence) {
      return json(call({ op: 'fd-seek', fd, offset, whence }, `fd-seek ${fd}`)) as number;
    },
    flush(fd) {
      call({ op: 'fd-flush', fd }, `fd-flush ${fd}`);
    },
    pread(fd, max, at) {
      const r = call({ op: 'fd-pread', fd, max, offset: at }, `fd-pread ${fd}`);
      return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
    },
    pwrite(fd, bytes, at) {
      return json(
        call({ op: 'fd-pwrite', fd, offset: at, body: bytes }, `fd-pwrite ${fd}`)
      ) as number;
    },
    isatty(fd) {
      return (
        (json(call({ op: 'fd-info', fd }, `fd-info ${fd}`)) as { tty?: boolean })?.tty === true
      );
    },
    ttyName(fd) {
      return (json(call({ op: 'fd-info', fd }, `fd-info ${fd}`)) as { name?: string })?.name;
    },
    kind(fd) {
      return (json(call({ op: 'fd-info', fd }, `fd-info ${fd}`)) as { kind?: string })?.kind;
    },
    heldMeta(fd) {
      return (json(call({ op: 'fd-info', fd }, `fd-info ${fd}`)) as { meta?: HeldMeta }).meta;
    },
    access(fd) {
      return (json(call({ op: 'fd-info', fd }, `fd-info ${fd}`)) as { access?: 'read' | 'write' })
        .access;
    },
    size(fd) {
      return (json(call({ op: 'fd-vfs-stat', fd }, `fd-vfs-stat ${fd}`)) as { size: number }).size;
    },
    fdStat(fd) {
      const r = json(call({ op: 'fd-vfs-stat', fd, full: true }, `fd-vfs-stat ${fd}`)) as
        | { stat?: object }
        | undefined;
      return r?.stat;
    },
    fdChmod(fd, mode) {
      call({ op: 'fd-chmod', fd, mode }, `fd-chmod ${fd}`);
    },
    fdChown(fd, uid, gid) {
      const ids = { ...(uid !== undefined ? { uid } : {}), ...(gid !== undefined ? { gid } : {}) };
      call({ op: 'fd-chown', fd, ...ids }, `fd-chown ${fd}`);
    },
    fdUtimes(fd, atimeMs, mtimeMs, now) {
      call({ op: 'fd-utimes', fd, atimeMs, mtimeMs, now }, `fd-utimes ${fd}`);
    },
    ttyNames() {
      return json(call({ op: 'fd-tty-names' }, 'fd-tty-names')) as string[];
    },
    ttyOwner(name) {
      return json(call({ op: 'fd-tty-owner', name }, `fd-tty-owner ${name}`)) as TtyOwner | null;
    },
    openTty(name) {
      const req =
        name === undefined ? { op: 'fd-open-tty' as const } : { op: 'fd-open-tty' as const, name };
      return json(call(req, `fd-open-tty ${name ?? ''}`)) as number;
    },
    tcgets(fd) {
      return json(call({ op: 'tty-get', fd }, `tty-get ${fd}`)) as Termios;
    },
    tcsets(fd, termios, flush) {
      call({ op: 'tty-set', fd, termios, ...(flush ? { flush } : {}) }, `tty-set ${fd}`);
    },
    winsize(fd) {
      return json(call({ op: 'tty-winsz', fd }, `tty-winsz ${fd}`)) as [number, number];
    },
    openPty() {
      return json(call({ op: 'pty-open' }, 'pty-open')) as number;
    },
    openPts(n, noctty) {
      return json(call({ op: 'pty-slave-open', n, noctty }, `pty-slave-open ${n}`)) as number;
    },
    openSealed(flags) {
      return json(call({ op: 'fd-open-sealed', flags }, 'fd-open-sealed')) as number;
    },
    openClipboard(flags) {
      return json(call({ op: 'fd-open-clipboard', flags }, 'fd-open-clipboard')) as number;
    },
    clipboardAbort(fd) {
      call({ op: 'fd-clipboard-abort', fd }, 'fd-clipboard-abort');
    },
    ptyNumbers() {
      return json(call({ op: 'pty-list' }, 'pty-list')) as number[];
    },
    procList() {
      return json(call({ op: 'proc-list' }, 'proc-list')) as ProcessListing;
    },
    mountList() {
      return json(call({ op: 'mount-list' }, 'mount-list')) as MountLine[];
    },
    setLock(target, kind, start, len, wait) {
      const req = { op: 'lk-set' as const, ...target, kind, start, len, ...(wait ? { wait } : {}) };
      call(req, 'lk-set');
    },
    getLock(target, kind, start, len) {
      return json(call({ op: 'lk-get', ...target, kind, start, len }, 'lk-get')) as LockHeld | null;
    },
    closeLocks(target) {
      call({ op: 'lk-close', ...target }, 'lk-close');
    },
    flock(fd, kind, wait) {
      call({ op: 'flock', fd, kind, ...(wait ? { wait } : {}) }, `flock ${fd}`);
    },
    ptyNumber(fd) {
      return json(call({ op: 'pty-number', fd }, `pty-number ${fd}`)) as number;
    },
    ptyLock(fd, lock) {
      call({ op: 'pty-lock', fd, lock }, `pty-lock ${fd}`);
    },
    setControllingTerminal(fd) {
      call({ op: 'pty-ctty', fd }, `pty-ctty ${fd}`);
    },
    setPacketMode(fd, on) {
      call({ op: 'pty-packet', fd, on }, `pty-packet ${fd}`);
    },
    setWinsize(fd, rows, cols) {
      call({ op: 'pty-winsz-set', fd, rows, cols }, `pty-winsz-set ${fd}`);
    },
  };
}

export function wireKernelFd(Fs: ProcessFs, streams: KernelStreams, entry: InheritedFd): void {
  if (entry.device && openDevice(Fs, entry.fd, entry.device)) return;

  placeKernelStream(Fs, streams, {
    ...entry,
    kind: entry.device ? 'stream' : entry.kind,
    kernel: entry.fd,
  });
}

const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_ACCMODE = 3;

const O_DIRECTORY = 0o200000;

const accessMode = (access: 'read' | 'write' | undefined): number =>
  access === 'read' ? O_RDONLY : access === 'write' ? O_WRONLY : O_RDWR;

function openDevice(Fs: ProcessFs, fd: number, meta: DeviceMeta): boolean {
  return openAt(Fs, fd, `/dev/${meta.device}`, accessMode(meta.access));
}

function openHeld(Fs: ProcessFs, fd: number, meta: HeldMeta): boolean {
  return 'dir' in meta
    ? openAt(Fs, fd, meta.dir, O_RDONLY | O_DIRECTORY)
    : openDevice(Fs, fd, meta);
}

function openAt(Fs: ProcessFs, fd: number, path: string, flags: number): boolean {
  let stream: ProcessStream;
  try {
    stream = Fs.open(path, flags);
  } catch {
    return false;
  }
  if (stream.fd !== fd) {
    Fs.dupStream(stream, fd);
    Fs.closeStream(stream.fd);
  }
  return true;
}

const PLACED: ReadonlySet<string> = new Set(['stream', 'file', 'socket', 'clipboard', 'sealed']);

export function wireKernelStdio(Fs: ProcessFs, streams: KernelStreams, sys?: ProcessSys): void {
  for (const fd of [0, 1, 2]) {
    const stream = Fs.getStream(fd);
    if (!stream) continue;
    const kind = sys?.kind?.(fd);
    const meta = kind === 'device' || kind === 'held' ? sys?.heldMeta?.(fd) : undefined;
    if (meta && openHeld(Fs, fd, meta)) continue;
    if (kind && PLACED.has(kind)) {
      const flags = sys?.access
        ? (stream.flags & ~O_ACCMODE) | accessMode(sys.access(fd))
        : stream.flags;
      Fs.closeStream(fd);
      const kernel = { fd, kernel: fd, kind: kind as InheritedFd['kind'], flags };
      placeKernelStream(Fs, streams, kernel).flags = flags;
      continue;
    }
    streams.attach(stream, fd);
    streams.nameTerminal(stream);
  }
}

interface RunningModule {
  FS: ProcessFs;
  callMain(args: string[]): number | undefined;
  sliccRunMain?: (args: string[]) => number | undefined;
  sliccForkChild?: (state: ForkState & { pid: number }) => number | undefined;
  PIPEFS?: ProcessPipeFs;

  sliccSigpipe?: () => number;

  sliccSigMask?: (which: number) => number;

  sliccRaise?: (sig: number) => void;

  sliccTimerFire?: (which: number) => boolean;

  sliccKernel?: ProcessKernel;

  sliccSyscalls?: GlueSyscalls;
}

export type GlueEvaluator = (glue: string, module: object) => void;

export function glueBody(glue: string): string {
  return glue.startsWith('#!') ? glue.slice(glue.indexOf('\n') + 1) : glue;
}

const GLUE_TRAILER = [
  "if (typeof ENV !== 'undefined') Object.assign(ENV, Module.sliccEnv);",
  "if (typeof thisProgram !== 'undefined' && Module.thisProgram === '') thisProgram = '';",
  'const __sliccTake = (name, value) => {',
  '  const own = Object.getOwnPropertyDescriptor(Module, name);',
  "  if (own && 'value' in own && own.value != null) return;",
  '  Object.defineProperty(Module, name, { value, writable: true, configurable: true, enumerable: true });',
  '};',
  "if (typeof FS !== 'undefined') __sliccTake('FS', FS);",
  "if (typeof callMain === 'function') __sliccTake('callMain', callMain);",
  "if (typeof sliccRunMain === 'function') __sliccTake('sliccRunMain', sliccRunMain);",
  "if (typeof sliccForkChild === 'function') __sliccTake('sliccForkChild', sliccForkChild);",
  "if (typeof PIPEFS !== 'undefined') __sliccTake('PIPEFS', PIPEFS);",

  'Module.sliccSyscalls ??= {',
  "  fcntl: typeof ___syscall_fcntl64 === 'function' ? ___syscall_fcntl64 : undefined,",
  "  pipe2: typeof ___syscall_pipe2 === 'function' ? ___syscall_pipe2 : undefined,",
  "  dup3: typeof ___syscall_dup3 === 'function' ? ___syscall_dup3 : undefined,",
  "  socket: typeof ___syscall_socket === 'function' ? ___syscall_socket : undefined,",
  "  accept4: typeof ___syscall_accept4 === 'function' ? ___syscall_accept4 : undefined,",
  "  ioctl: typeof ___syscall_ioctl === 'function' ? ___syscall_ioctl : undefined,",
  "  setitimer: typeof __setitimer_js === 'function' ? __setitimer_js : undefined,",
  '};',
  'Module.sliccKernelImports ??= {',
  "  openat: typeof ___syscall_openat === 'function' ? ___syscall_openat : undefined,",
  "  mkdirat: typeof ___syscall_mkdirat === 'function' ? ___syscall_mkdirat : undefined,",
  "  mknodat: typeof ___syscall_mknodat === 'function' ? ___syscall_mknodat : undefined,",
  "  umask: typeof ___syscall_umask === 'function' ? ___syscall_umask : undefined,",
  "  faccessat: typeof ___syscall_faccessat === 'function' ? ___syscall_faccessat : undefined,",
  "  linkat: typeof ___syscall_linkat === 'function' ? ___syscall_linkat : undefined,",
  "  symlinkat: typeof ___syscall_symlinkat === 'function' ? ___syscall_symlinkat : undefined,",
  "  uname: typeof ___syscall_uname === 'function' ? ___syscall_uname : undefined,",
  "  utimensat: typeof ___syscall_utimensat === 'function' ? ___syscall_utimensat : undefined,",
  "  getppid: typeof _slicc_getppid_js === 'function' ? _slicc_getppid_js : undefined,",
  "  resizeHeap: typeof _emscripten_resize_heap === 'function' ? _emscripten_resize_heap : undefined,",
  "  fdWrite: typeof _fd_write === 'function' ? _fd_write : undefined,",
  "  fdRead: typeof _fd_read === 'function' ? _fd_read : undefined,",
  "  sleepMs: typeof slicc_sleep_ms === 'function' ? slicc_sleep_ms : undefined,",
  "  flock: typeof __syscall_flock === 'function' ? __syscall_flock : undefined,",
  '};',
  'Module.sliccFdImports ??= {',
  "  fd_sync: typeof _fd_sync === 'function' ? _fd_sync : undefined,",
  "  fd_pread: typeof _fd_pread === 'function' ? _fd_pread : undefined,",
  "  fd_pwrite: typeof _fd_pwrite === 'function' ? _fd_pwrite : undefined,",
  '};',

  'const __sliccUp = () =>',
  "  (typeof runtimeInitialized === 'undefined' || runtimeInitialized) &&",
  "  !(typeof runtimeExited !== 'undefined' && runtimeExited) &&",
  "  !(typeof ABORT !== 'undefined' && ABORT);",
  "Module.sliccSigpipe ??= () => (__sliccUp() && typeof _slicc_sigpipe === 'function' ? _slicc_sigpipe() : -1);",

  "Module.sliccSigMask ??= (w) => (__sliccUp() && typeof _slicc_sig_mask === 'function' ? _slicc_sig_mask(w) : -1);",
  "Module.sliccRaise ??= (sig) => { if (__sliccUp() && typeof _slicc_raise === 'function') _slicc_raise(sig); };",

  'Module.sliccTimerFire ??= (which) => {',
  "  if (!__sliccUp() || typeof __emscripten_timeout !== 'function') return false;",
  "  __emscripten_timeout(which, typeof _emscripten_get_now === 'function' ? _emscripten_get_now() : performance.now());",
  '  return true;',
  '};',

  "if (typeof SliccFork !== 'undefined' && !SliccFork.balancesKeepalive && typeof runtimeKeepalivePop === 'function') {",
  '  let __sliccForking = SliccFork.forking === true;',
  "  Object.defineProperty(SliccFork, 'forking', {",
  '    get: () => __sliccForking,',
  '    set: (on) => { if (__sliccForking && !on) runtimeKeepalivePop(); __sliccForking = on; },',
  '    configurable: true,',
  '  });',
  '}',
].join('\n');

export function ownValue<T>(module: object, name: string): T | undefined {
  const own = Object.getOwnPropertyDescriptor(module, name);
  return own && 'value' in own ? (own.value as T | undefined) : undefined;
}

export const evaluateGlue: GlueEvaluator = (glue, module) => {
  let run: (module: object) => void;
  try {
    run = new Function('Module', `${glueBody(glue)}\n;${GLUE_TRAILER}`) as (module: object) => void;
  } catch (e) {
    throw e instanceof EvalError ? new Error(EVAL_BLOCKED) : e;
  }
  run(module);
};

export const EVAL_BLOCKED =
  "the wasm realm evaluates the program's Emscripten glue, and this page's CSP forbids eval " +
  "(no 'unsafe-eval')";

export function identify(
  transport: SyncSabTransport,
  init: { pid: number; ppid?: number }
): { pid: number; ppid: number } {
  const r = transport.call({ op: 'proc-identity' }, Number.POSITIVE_INFINITY, 'proc-identity');
  const id = r.ok && r.kind === 'json' ? (r.json as { pid: number; ppid: number } | null) : null;
  return id ?? { pid: init.pid, ppid: init.ppid ?? 1 };
}

export function liveParent(
  imports: WebAssembly.Imports,
  parent: () => number,
  glue?: KernelImports
): void {
  wrapImport(imports, 'getppid', glue, () => parent);
}

export function signalMasks(
  m: Pick<RunningModule, 'sliccSigMask'>
): { caught: number; ignored: number; restart: number } | null {
  const mask = m.sliccSigMask;
  const caught = mask?.(0) ?? -1;
  if (!mask || caught === -1) return null;
  return { caught, ignored: mask(1), restart: mask(2) };
}

export function reportGrowth(
  imports: WebAssembly.Imports,
  publish: () => void,
  glue?: KernelImports
): void {
  wrapImport(imports, 'resizeHeap', glue, (resize) => (...args) => {
    const grown = resize(...args);
    publish();
    return grown;
  });
}

export function holdWhileStopped(
  imports: WebAssembly.Imports,
  header: Int32Array,
  glue?: KernelImports,
  poll: () => void = () => undefined
): void {
  const hold = () => {
    while (Atomics.load(header, SAB_I_STOP) === 1) Atomics.wait(header, SAB_I_STOP, 1);
    const due =
      Atomics.load(header, SAB_I_SIGNALS) |
      Atomics.load(header, SAB_I_TIMERS) |
      Atomics.load(header, SAB_I_KILLED);
    if (due !== 0) poll();
  };
  for (const name of ['fdWrite', 'fdRead', 'sleepMs'] as const) {
    wrapImport(
      imports,
      name,
      glue,
      (original) =>
        (...args) => {
          while (Atomics.load(header, SAB_I_STOP) === 1) Atomics.wait(header, SAB_I_STOP, 1);
          const done = original(...args);
          hold();
          return done;
        },
      true
    );
  }
}

function callerOwner(Fs: ProcessFs, init: WasmProcessInitMsg): { owner?: Owner } {
  return init.owners ? {} : { owner: ownByCaller(Fs, init.cred, credAbi(init.program.glue)) };
}

function utimensatOf(module: object): unknown {
  return ownValue<{ utimensat?: unknown }>(module, 'sliccSyscalls')?.utimensat;
}

interface WrapperDeps {
  init: WasmProcessInitMsg;
  transport: SyncSabTransport;
  sys: ProcessSys & LockKernel;
  memory: () => WebAssembly.Memory | undefined;
  ppid: () => number;
  poll: () => void;
}

function kernelWrappers(imports: WebAssembly.Imports, module: object, deps: WrapperDeps): void {
  const { init, transport, sys, memory } = deps;
  const kernelGlue = ownValue<KernelImports>(module, 'sliccKernelImports');
  liveParent(imports, deps.ppid, kernelGlue);
  kernelUmask(imports, {
    glue: kernelGlue,
    initial: init.umask ?? 0o022,
    memory,
    set: (mask) =>
      void transport.call({ op: 'proc-umask', mask }, Number.POSITIVE_INFINITY, 'umask'),
  });
  const fsOf = () => ownValue<ProcessFs>(module, 'FS');
  noFollowUtimes(imports, fsOf, kernelGlue?.utimensat ?? utimensatOf(module), memory);
  kernelAccess(imports, fsOf, memory, kernelGlue);
  kernelLink(imports, fsOf, memory, kernelGlue);
  devCreations(imports, fsOf, memory, kernelGlue);
  kernelUname(imports, hostnameOf(init.env), memory, kernelGlue);
  wrapImport(
    imports,
    'flock',
    kernelGlue,
    () => kernelFlock({ fs: fsOf, flock: (fd, kind, wait) => sys.flock?.(fd, kind, wait) }),
    true
  );
  const glue = ownValue<FdImports>(module, 'sliccFdImports');
  syncFsync(imports, fsOf, glue);
  positionalIo(imports, { glue, fs: fsOf, sys, memory });
  const grown = () => publishMemory(init.sab, memory()?.buffer.byteLength ?? 0);
  reportGrowth(imports, grown, kernelGlue);
  holdWhileStopped(imports, new Int32Array(init.sab, 0, SAB_HEADER_I32), kernelGlue, deps.poll);
}

function bridgeFlags(init: WasmProcessInitMsg): {
  owners?: boolean;
  links?: boolean;
  changes?: SharedArrayBuffer;
} {
  return {
    ...(init.owners ? { owners: true } : {}),
    ...(init.links ? { links: true } : {}),
    ...(init.changes ? { changes: init.changes } : {}),
  };
}

function credSyncTransport(
  gated: SyncSabTransport,
  early: () => void,
  cred: Cred | undefined
): SyncSabTransport {
  return {
    call: (req, timeoutMs, label) => {
      if (!FS_OPS.has(req.op)) early();
      const r = gated.call(req, timeoutMs, label);
      if (cred && req.op === 'proc-setcred' && r.ok && r.kind === 'json')
        Object.assign(cred, r.json);
      return r;
    },
  };
}

function sigpipeSpared(transport: SyncSabTransport): boolean {
  const req = { op: 'proc-kill-self' as const, sig: SIG.PIPE, probe: true };
  const r = transport.call(req, Number.POSITIVE_INFINITY, 'proc-kill-self');
  return r.ok && !(r.kind === 'json' && r.json === 'terminate');
}

export async function runWasmProcess(
  init: WasmProcessInitMsg,
  port: SabPostLike,
  deps: { evaluate?: GlueEvaluator; warn?: (message: string) => void } = {}
): Promise<number> {
  const signals = new SignalGate(
    createSyncSabTransport(init.sab, port, {
      memory: () => memory?.buffer.byteLength ?? 0,
    }),
    new Int32Array(init.sab, 0, SAB_HEADER_I32),
    {
      masks: () => signalMasks(module as unknown as RunningModule),
      raise: (sig) => (module as unknown as RunningModule).sliccRaise?.(sig),
      timer: (which) => {
        const running = module as unknown as RunningModule;
        if (!running.sliccTimerFire?.(which)) running.sliccRaise?.(SIG.ALRM);
      },
    }
  );
  const gated = signals.transport();
  let early = (): void => {};
  const transport = credSyncTransport(gated, () => early(), init.cred);
  const sys = kernelSys(transport);
  const encoder = new TextEncoder();
  const say = (fd: number) => (text: string) => sys.write(fd, encoder.encode(`${text}\n`));
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  let memory: WebAssembly.Memory | undefined;
  let exports: WebAssembly.Exports | undefined;
  let atExit: () => () => void = () => () => {};
  const initialized = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const id = identify(transport, init);
  const module = {
    noInitialRun: true,
    thisProgram: init.argv0,
    sliccPid: id.pid,
    sliccPpid: id.ppid,
    sliccEnv: init.env,
    sliccKernel: { sigInherited: () => inheritedSignals(transport) },
    print: say(1),
    printErr: say(2),
    instantiateWasm(
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ): object {
      Promise.resolve()
        .then(() => {
          wrapCloexecSyscalls(imports, ownValue<GlueSyscalls>(module, 'sliccSyscalls'), {
            fs: () => ownValue<ProcessFs>(module, 'FS'),
            heap: () => (memory ? new Int32Array(memory.buffer) : undefined),
            pty: sys,
            locks: { kernel: sys, memory: () => memory?.buffer, flush: () => early() },
            timer: {
              arm: (ms) => {
                transport.call(
                  { op: 'proc-alarm', sig: SIG.ALRM, ms, repeat: false, timer: 0 },
                  Number.POSITIVE_INFINITY,
                  'alarm'
                );
              },
            },
          });
          kernelWrappers(imports, module, {
            init,
            transport,
            sys,
            memory: () => memory,
            ppid: () => identify(transport, init).ppid,
            poll: () => void signals.interrupt(),
          });
          return WebAssembly.instantiate(init.program.module, watchOutside(imports));
        })
        .then((instance) => {
          memory = wasmMemory(instance, imports);
          port.postMessage({ type: WASM_PROCESS_READY });
          exports = instance.exports;
          publishMemory(init.sab, memory?.buffer.byteLength ?? 0);
          done(
            withExitHook(instance, () => atExit()),
            init.program.module
          );
        }, failed);
      return {};
    },

    preRun: [
      (m: object) => {
        if (!hasStreams(m)) return;
        const fs = (m as RunningModule).FS;

        trackCloseOnExec(fs);
        pathOpensLinks(fs);
        try {
          fs.mkdirTree(init.cwd);
          fs.chdir(init.cwd);
        } catch {}
      },
    ],
    onRuntimeInitialized: () => ready(),
  };
  (deps.evaluate ?? evaluateGlue)(init.program.glue, module);
  await initialized;
  const running = module as unknown as RunningModule;
  if (!hasStreams(running)) return runStdioOnly(running, init);
  if (init.owners) linuxDevices(running.FS);
  const vfs = mountVfsIntoEmscripten(running.FS, {
    bridge: createSyncFsSabBridge(transport, bridgeFlags(init)),
    cwd: init.cwd,
    warn: deps.warn ?? say(2),
    cred: init.owners ? init.cred : undefined,
  });
  early = () => signals.quiet(() => vfs.flushDirty());
  closeDropsLocks(running.FS, sys);
  const sigpipe = (): boolean => running.sliccSigpipe?.() === 1 || sigpipeSpared(gated);
  const restartable = (): boolean => signals.restartable();
  const owners = init.owners ? { owners: true } : {};
  const streams = new KernelStreams(running.FS, sys, {
    sigpipe,
    restartable,
    ...owners,
    program: init.argv0,
  });
  trackCloseOnExec(running.FS);
  quietQuit(running.FS as unknown as QuitFs, (on) => {
    streams.quitting = on;
  });
  atExit = () => streams.exiting();
  useMounts(running.FS, init.env, true);
  useZeroDevices(running.FS);
  useProcfs(running.FS as unknown as ProcFs, sys, init.pid);
  if (init.fork) restoreForkedStreams(running.FS, streams, init.fork.streams ?? []);
  else {
    wireKernelStdio(running.FS, streams, sys);
    for (const entry of init.fds ?? []) wireKernelFd(running.FS, streams, entry);
  }
  const pipefs = ownValue<ProcessPipeFs>(running, 'PIPEFS');
  if (pipefs) streams.usePipes(pipefs);
  streams.useControllingTerminal();
  streams.useKernelFdMetadata();
  useDevFd(running.FS);
  useDevRemoval(running.FS);
  useFifoOpens(running.FS, (stream, path) => streams.attachFifo(stream, path));
  useFileMmap(running.FS, {
    sys,
    memory: () => memory,
    memalign: () => exports?.emscripten_builtin_memalign as Memalign | undefined,
  });
  const livePath = (s: ProcessStream) => liveNodePath(s.node as unknown as LiveFsNode);
  running.sliccKernel = createProcessKernel({
    transport,
    Fs: running.FS,
    env: init.env,
    pid: init.pid,
    beforeSpawn: () => vfs.flush(),
    afterChild: () => vfs.invalidate(),
    raise: (sig) => running.sliccRaise?.(sig),
    restartable,
    memory: () => memory,
    deliveries: () => signals.deliveries(),
    describeFork: () => describeForFork(running.FS, sys, streams, livePath),
    inherit: (actions) => describeInherited(running.FS, sys, streams, livePath, actions),
    stdioPromoter: () => vfsPromoter(running.FS, sys, streams, livePath),
    ...callerOwner(running.FS, init),
  });
  running.sliccKernel.http = createHttpKernel(transport);
  running.sliccKernel.hostname = hostnameOf(init.env);
  running.sliccKernel.net = createSocketKernel({
    transport,
    Fs: running.FS,
    sys,
    streams,
    sigpipe,
    restartable,
  });
  return runWithFlush(running, init, streams, vfs);
}

function runWithFlush(
  running: RunningModule,
  init: WasmProcessInitMsg,
  streams: KernelStreams,
  vfs: { flush(): void }
): number {
  try {
    return streams.exitStatus(runMain(running, init));
  } finally {
    try {
      vfs.flush();
    } catch {}
  }
}

interface QuitFs {
  quit?: () => void;
  close: (stream: unknown) => void;
}

function withExitHook(
  instance: WebAssembly.Instance,
  begin: () => () => void
): WebAssembly.Instance {
  const funcs = instance.exports.__funcs_on_exit;
  if (typeof funcs !== 'function') return instance;
  const run = funcs as () => void;
  const exported = Object.assign(Object.create(null), instance.exports, {
    __funcs_on_exit: () => {
      const end = begin();
      try {
        run();
      } finally {
        end();
      }
    },
  });
  return { exports: exported } as WebAssembly.Instance;
}

export function quietQuit(Fs: QuitFs, quitting?: (on: boolean) => void): void {
  const { quit, close } = Fs;
  if (!quit) return;
  Fs.quit = () => {
    quitting?.(true);
    Fs.close = (stream) => {
      try {
        close.call(Fs, stream);
      } catch {}
    };
    try {
      quit.call(Fs);
    } finally {
      quitting?.(false);
      Fs.close = close;
    }
  };
}

function hasStreams(module: object): boolean {
  return typeof ownValue<Partial<ProcessFs>>(module, 'FS')?.getStream === 'function';
}

function runStdioOnly(running: RunningModule, init: WasmProcessInitMsg): number {
  if (init.fork) throw new Error(`${init.argv0} cannot resume a fork: it has no filesystem`);
  return runMain(running, init);
}

function runMain(running: RunningModule, init: WasmProcessInitMsg): number {
  try {
    if (init.fork) {
      if (!running.sliccForkChild) throw new Error(`${init.argv0} cannot resume a fork`);
      return running.sliccForkChild({ ...init.fork, pid: init.pid }) ?? 0;
    }

    return (running.sliccRunMain ?? running.callMain)(init.args) ?? 0;
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (typeof status !== 'number') throw e;
    return status;
  }
}

const OUTSIDE: ReadonlySet<string> = new Set([
  'clock_time_get',
  'emscripten_date_now',
  'emscripten_get_now',
  'random_get',
  'getentropy',
]);

function watchOutside(imports: WebAssembly.Imports): WebAssembly.Imports {
  for (const space of Object.values(imports)) {
    for (const [name, value] of Object.entries(space)) {
      if (!OUTSIDE.has(name) || typeof value !== 'function') continue;
      const look = value as (...args: unknown[]) => unknown;
      space[name] = (...args: unknown[]) => {
        lookedOutside();
        return look(...args);
      };
    }
  }
  return imports;
}
