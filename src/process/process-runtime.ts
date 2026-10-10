import type { DeviceMeta, PollState } from '../kernel/fd-table.ts';
import { hostnameOf } from '../kernel/net/loopback-names.ts';
import type { MountLine, ProcessListing } from '../kernel/proc-info.ts';
import type { ForkState, InheritedFd, WasmProcessInitMsg } from '../kernel/protocol.ts';
import { SIG } from '../kernel/signals.ts';
import type { Termios } from '../kernel/tty.ts';
import { mountVfsIntoEmscripten } from '../realm/emscripten-vfs-hook.ts';
import { type LiveFsNode, liveNodePath } from '../realm/live-vfs-fs.ts';
import { SYNC_FS_OPS, type SyncFsResult } from '../realm/sync-fs-wire.ts';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SabPostLike,
  type SyncSabTransport,
} from '../realm/sync-sab-bridge.ts';
import { publishMemory, SAB_HEADER_I32, type SyncSabRequestBody } from '../realm/sync-sab-wire.ts';
import {
  KernelStreams,
  type ProcessFs,
  type ProcessPipeFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.ts';
import { createProcessKernel, type ProcessKernel } from './process-children.ts';
import {
  type FdImports,
  type GlueSyscalls,
  type Memalign,
  noFollowUtimes,
  pathOpensLinks,
  positionalIo,
  syncFsync,
  trackCloseOnExec,
  useDevFd,
  useFileMmap,
  useMounts,
  useZeroDevices,
  wasmMemory,
  wrapCloexecSyscalls,
} from './process-fds.ts';
import {
  describeForFork,
  describeInherited,
  placeKernelStream,
  restoreForkedStreams,
  vfsPromoter,
} from './process-fork.ts';
import { createHttpKernel } from './process-http.ts';
import type { PtyKernel } from './process-pty.ts';
import { SignalGate } from './process-signals.ts';
import { createSocketKernel } from './process-sockets.ts';
import { type ProcFs, useProcfs } from './procfs.ts';
import { ownByRealmUser } from './realm-user.ts';

export {
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.ts';

const FS_OPS: ReadonlySet<string> = new Set(SYNC_FS_OPS);

export function kernelSys(transport: SyncSabTransport): ProcessSys & PtyKernel {
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
            ...(opts?.pin ? { pin: opts.pin } : {}),
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
    size(fd) {
      return (json(call({ op: 'fd-vfs-stat', fd }, `fd-vfs-stat ${fd}`)) as { size: number }).size;
    },
    openTty(name) {
      const req =
        name === undefined ? { op: 'fd-open-tty' as const } : { op: 'fd-open-tty' as const, name };
      return json(call(req, `fd-open-tty ${name ?? ''}`)) as number;
    },
    tcgets(fd) {
      return json(call({ op: 'tty-get', fd }, `tty-get ${fd}`)) as Termios;
    },
    tcsets(fd, termios) {
      call({ op: 'tty-set', fd, termios }, `tty-set ${fd}`);
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
    ptyNumbers() {
      return json(call({ op: 'pty-list' }, 'pty-list')) as number[];
    },
    procList() {
      return json(call({ op: 'proc-list' }, 'proc-list')) as ProcessListing;
    },
    mountList() {
      return json(call({ op: 'mount-list' }, 'mount-list')) as MountLine[];
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

function openDevice(Fs: ProcessFs, fd: number, meta: DeviceMeta): boolean {
  const flags = meta.access === 'read' ? O_RDONLY : meta.access === 'write' ? O_WRONLY : O_RDWR;
  let stream: ProcessStream;
  try {
    stream = Fs.open(`/dev/${meta.device}`, flags);
  } catch {
    return false;
  }
  if (stream.fd !== fd) {
    Fs.dupStream(stream, fd);
    Fs.closeStream(stream.fd);
  }
  return true;
}

const PLACED: ReadonlySet<string> = new Set(['stream', 'file', 'socket']);

export function wireKernelStdio(Fs: ProcessFs, streams: KernelStreams, sys?: ProcessSys): void {
  for (const fd of [0, 1, 2]) {
    const stream = Fs.getStream(fd);
    if (!stream) continue;
    const kind = sys?.kind?.(fd);
    if (kind && PLACED.has(kind)) {
      const { flags } = stream;
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

export function liveParent(imports: WebAssembly.Imports, parent: () => number): void {
  const env = imports.env as Record<string, unknown> | undefined;
  if (env && typeof env.slicc_getppid_js === 'function') env.slicc_getppid_js = parent;
}

export function signalMasks(
  m: Pick<RunningModule, 'sliccSigMask'>
): { caught: number; ignored: number; restart: number } | null {
  const mask = m.sliccSigMask;
  const caught = mask?.(0) ?? -1;
  if (!mask || caught === -1) return null;
  return { caught, ignored: mask(1), restart: mask(2) };
}

export function reportGrowth(imports: WebAssembly.Imports, publish: () => void): void {
  const env = imports.env as Record<string, unknown> | undefined;
  const resize = env?.emscripten_resize_heap;
  if (!env || typeof resize !== 'function') return;
  env.emscripten_resize_heap = (...args: unknown[]) => {
    const grown = resize(...args);
    publish();
    return grown;
  };
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
  const transport: SyncSabTransport = {
    call: (req, timeoutMs, label) => {
      if (!FS_OPS.has(req.op)) early();
      return gated.call(req, timeoutMs, label);
    },
  };
  const sys = kernelSys(transport);
  const encoder = new TextEncoder();
  const say = (fd: number) => (text: string) => sys.write(fd, encoder.encode(`${text}\n`));
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  let memory: WebAssembly.Memory | undefined;
  let exports: WebAssembly.Exports | undefined;
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
          liveParent(imports, () => identify(transport, init).ppid);
          noFollowUtimes(
            imports,
            () => ownValue<ProcessFs>(module, 'FS'),
            ownValue<{ utimensat?: unknown }>(module, 'sliccSyscalls')?.utimensat
          );
          const glue = ownValue<FdImports>(module, 'sliccFdImports');
          syncFsync(imports, () => ownValue<ProcessFs>(module, 'FS'), glue);
          positionalIo(imports, {
            glue,
            fs: () => ownValue<ProcessFs>(module, 'FS'),
            sys,
            memory: () => memory,
          });
          reportGrowth(imports, () => publishMemory(init.sab, memory?.buffer.byteLength ?? 0));
          return WebAssembly.instantiate(init.program.module, imports);
        })
        .then((instance) => {
          memory = wasmMemory(instance, imports);
          exports = instance.exports;
          publishMemory(init.sab, memory?.buffer.byteLength ?? 0);
          done(instance, init.program.module);
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
  const vfs = mountVfsIntoEmscripten(running.FS, {
    bridge: createSyncFsSabBridge(transport),
    cwd: init.cwd,
    warn: deps.warn ?? say(2),
  });
  early = () => vfs.flushDirty();
  const sigpipe = (): boolean => running.sliccSigpipe?.() === 1;
  const restartable = (): boolean => signals.restartable();
  const streams = new KernelStreams(running.FS, sys, { sigpipe, restartable });
  trackCloseOnExec(running.FS);
  quietQuit(running.FS as unknown as QuitFs);
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
  useDevFd(running.FS);
  useFileMmap(running.FS, {
    sys,
    memory: () => memory,
    memalign: () => exports?.emscripten_builtin_memalign as Memalign | undefined,
  });
  ownByRealmUser(running.FS);
  const livePath = (s: ProcessStream) => liveNodePath(s.node as unknown as LiveFsNode);
  running.sliccKernel = createProcessKernel({
    transport,
    Fs: running.FS,
    env: init.env,
    beforeSpawn: () => vfs.flush(),
    afterChild: () => vfs.invalidate(),
    pid: init.pid,
    raise: (sig) => running.sliccRaise?.(sig),
    restartable,
    describeFork: () => describeForFork(running.FS, sys, streams, livePath),
    inherit: (actions) => describeInherited(running.FS, sys, streams, livePath, actions),
    stdioPromoter: () => vfsPromoter(running.FS, sys, streams, livePath),
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
  try {
    return runMain(running, init);
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

export function quietQuit(Fs: QuitFs): void {
  const { quit, close } = Fs;
  if (!quit) return;
  Fs.quit = () => {
    Fs.close = (stream) => {
      try {
        close.call(Fs, stream);
      } catch {}
    };
    try {
      quit.call(Fs);
    } finally {
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
