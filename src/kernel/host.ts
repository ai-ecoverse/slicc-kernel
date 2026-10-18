import { Created, type Dac } from '../fs/dac.ts';
import { type PathGate, type Replacements, UNLINKED_DIR } from '../fs/unlinked.ts';
import { HeldPaths } from '../mount/mount-fs.ts';
import { dispatchSyncFs } from '../realm/sync-fs-dispatch.ts';
import {
  mintSyncFsToken,
  revokeSyncFsToken,
  type SourceCheck,
  type SyncFsTokenEntry,
} from '../realm/sync-fs-token-registry.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import {
  attachSyncSabResponder,
  type SyncSabDispatchRequest,
} from '../realm/sync-sab-responder.ts';
import {
  anyBlocked,
  type BlockedMask,
  loadBlocked,
  SAB_DEFAULT_WINDOW_BYTES,
  SAB_HEADER_BYTES,
  SAB_HEADER_I32,
  SAB_I_ASYNC,
  SAB_I_BLOCKED,
  SAB_I_KILLED,
  SAB_I_MEMORY,
  SAB_I_SIGNALS,
  SAB_I_STOP,
  SAB_I_TIMERS,
  storeBlocked,
} from '../realm/sync-sab-wire.ts';
import type { ChildForker, ChildSpawner } from './children.ts';
import type { ClipboardBroker } from './clipboard.ts';
import { type CpuTimes, ProcessClocks } from './cpu-clock.ts';
import { type Cred, copyCred } from './cred.ts';
import { type FdTable, kernelFdKind, type OpenFile } from './fd-table.ts';
import type { FifoTable } from './fifo.ts';
import type { JobTable } from './jobs.ts';
import type { KernelLocks } from './lock-service.ts';
import type { HttpHandles } from './net/http-syscalls.ts';
import type { Resolver } from './net/resolver.ts';
import type { MountLine, ProcessListing } from './proc-info.ts';
import {
  isWasmSyscall,
  type StateListener,
  WasmProcess,
  type WasmProcessOptions,
  type WasmSyscall,
} from './process.ts';
import {
  type ForkState,
  type InheritedFd,
  type JsLane,
  type ProcessInitMsg,
  type Program,
  WASM_MAX_THREADS,
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  WASM_PROCESS_READY,
  WASM_THREAD_EXIT,
  WASM_THREAD_INIT,
  WASM_THREAD_SPAWN,
  type WasmThread,
  type WasmThreadInitMsg,
} from './protocol.ts';
import type { PtyTable } from './pty.ts';
import type { SealedBroker } from './sealed.ts';
import type { SemTable } from './sem.ts';
import { SIG, type SigInfo, sigbit } from './signals.ts';
import { KernelSocket, type LoopbackNet } from './socket.ts';
import { isDatagram } from './unix-dgram.ts';
import type { VfsNodes } from './vfs-file.ts';

export interface WasmWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message' | 'error', handler: (event: MessageEvent) => void): void;
  terminate(): void;
}

export interface SpawnWasmOptions {
  pid: number;
  changes?: SharedArrayBuffer;
  ignored?: number;
  blocked?: BlockedMask;
  umask?: number;
  cred?: Cred;
  owners?: boolean;
  links?: number;
  fresh?: (path: string, umask: number) => void;
  source?: SourceCheck;
  sealed?: SealedBroker;
  outputFilter?: (file: OpenFile) => OpenFile;
  clipboard?: ClipboardBroker;
  readonlyAt?: (path: string) => boolean;
  dac?: Dac;
  identity?: () => Promise<{ pid: number; ppid: number }>;
  onSyscall?: (req: WasmSyscall) => void;

  settling?: () => boolean;
  program: Program;
  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  fds: FdTable;
  fs: SyncFsTokenEntry['fs'];
  noLinks: SyncFsTokenEntry['fs'];
  createWorker: () => WasmWorkerLike;
  onError?: (message: string) => void;
  onOom?: () => boolean;
  spawner?: ChildSpawner;
  forker?: ChildForker;
  fork?: ForkState;
  ppid?: number;

  shownPid?: number;
  kill?: (pid: number, sig: number, info?: SigInfo) => boolean | Promise<boolean>;
  writesBack?: (pid: number) => boolean;
  processes?: () => ProcessListing;
  sudo?: WasmProcessOptions['sudo'];
  crontab?: WasmProcessOptions['crontab'];
  openFiles?: Set<VfsNodes>;
  nodes?: VfsNodes;
  statfs?: (path: string) => Promise<{ quota: number; usage: number } | undefined>;
  mounts?: () => MountLine[];
  mount?: WasmProcessOptions['mount'];
  umount?: WasmProcessOptions['umount'];
  held?: Set<HeldPaths>;
  unlinkGate?: PathGate;
  replacements?: Replacements;
  jobs?: JobTable;
  ptys?: PtyTable;

  net?: LoopbackNet;

  http?: HttpHandles;
  locks?: KernelLocks;
  fifos?: FifoTable;
  sems?: SemTable;
  watches?: WasmProcessOptions['watches'];
  onReap?: (pid: number) => void;
  resolver?: Resolver;
}

export interface WasmProcessHandle {
  pid: number;
  exited: Promise<number>;
  kill(code?: number): void;
  signal(sig: number, info?: SigInfo): void;
  termsig(): number | undefined;
  onState(listener: StateListener): void;
  memory(): number;
  ignoredSignals(fork?: boolean): number;
  blockedSignals?(): BlockedMask;
  signalMasks?(): { ignored: number; caught: number };
  umask?(): number;
  cred?(): Cred;
  writesBack(): boolean;
  times?(): CpuTimes | undefined;
  running?(): number;
  threads?(): Array<{ tid: number; state: 'R' | 'S' }>;
  ready?: Promise<boolean>;
}

const CRASHED = 70;
const NO_MEMORY = 126;
const WASM_OOM = /Cannot allocate Wasm memory|WebAssembly\.Memory\(\): could not allocate memory/;

export const KILL_GRACE_MS = 2000;
export const KILL_HARD_MS = 5000;

const descIds = new WeakMap<OpenFile, number>();
let nextDescId = 1;

function descId(file: OpenFile): number {
  const id = descIds.get(file) ?? nextDescId++;
  descIds.set(file, id);
  return id;
}

export function inheritedFds(fds: FdTable): InheritedFd[] {
  return fds
    .numbers()
    .filter((fd) => fd > 2 && !fds.get(fd).file.held)
    .map((fd): InheritedFd => {
      const open = fds.get(fd);
      const flags = fds.statusFlags(fd);
      const kind =
        open.file instanceof KernelSocket || isDatagram(open.file)
          ? 'socket'
          : kernelFdKind(open.file);
      const meta = open.file.heldMeta;
      return {
        fd,
        kind,
        ...(kind === 'device' && meta && 'device' in meta ? { device: meta } : {}),
        ...(flags !== undefined ? { flags } : {}),
        ...(fds.closesOnExec(fd) ? { cloexec: true } : {}),
        ...(kind === 'stream' ? { desc: descId(open) } : {}),
        ...(open.file.fifo ? { fifo: open.file.fifo } : {}),
      };
    });
}

interface WorkerSays {
  type?: string;
  code?: unknown;
  message?: unknown;
  thread?: WasmThread;
}

class Dying {
  ending: { code: number; sig: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private hard: ReturnType<typeof setTimeout> | undefined;
  private busy = 0;
  private finish: (() => void) | undefined;

  start(code: number, sig: number, header: Int32Array, process: WasmProcess, finish: () => void) {
    if (this.ending) return;
    this.ending = { code, sig };
    this.finish = finish;
    this.hard = setTimeout(finish, KILL_HARD_MS);
    this.arm();
    Atomics.store(header, SAB_I_KILLED, code);
    process.die();
  }

  serve<T>(req: SyncSabDispatchRequest, work: () => Promise<T>): Promise<T> {
    return this.ending && isWasmSyscall(req) ? work() : this.serving(work);
  }

  async serving<T>(work: () => Promise<T>): Promise<T> {
    this.busy++;
    clearTimeout(this.timer);
    try {
      return await work();
    } finally {
      this.busy--;
      this.arm();
    }
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (this.busy === 0 && this.finish) this.timer = setTimeout(this.finish, KILL_GRACE_MS);
  }

  clear(): void {
    clearTimeout(this.timer);
    clearTimeout(this.hard);
  }

  status(reported: unknown): [number, number | undefined] {
    if (this.ending) return [this.ending.code, this.ending.sig];
    return [typeof reported === 'number' ? reported : CRASHED, undefined];
  }
}

interface ThreadSignals {
  header: Int32Array;
  interrupt: AbortController;
}

function killThread(thread: ThreadSignals | undefined, caught: number, sig: number): boolean {
  if (!thread) return false;
  const held = (Atomics.load(thread.header, SAB_I_BLOCKED) & sigbit(sig)) !== 0;
  if (!held && (caught & sigbit(sig)) === 0) return false;
  Atomics.or(thread.header, SAB_I_SIGNALS, sigbit(sig));
  Atomics.notify(thread.header, SAB_I_SIGNALS);
  if (held) return true;
  const blocked = thread.interrupt;
  thread.interrupt = new AbortController();
  blocked.abort();
  return true;
}

function unblockedThread(threads: Map<number, ThreadSignals>, sig: number): number | undefined {
  for (const [tid, thread] of threads) {
    if ((Atomics.load(thread.header, SAB_I_BLOCKED) & sigbit(sig)) === 0) return tid;
  }
  return undefined;
}

function unblocked(header: Int32Array): number {
  return Atomics.load(header, SAB_I_SIGNALS) & ~Atomics.load(header, SAB_I_BLOCKED);
}

function threadCall(
  process: WasmProcess,
  req: SyncSabDispatchRequest,
  cancelled: AbortSignal,
  block: () => void
): Promise<SyncFsResult> {
  return isWasmSyscall(req) ? process.syscall(req, cancelled, block) : dispatchSyncFs(req);
}

function threadSignalsOf(sab: SharedArrayBuffer): ThreadSignals {
  return { header: new Int32Array(sab, 0, SAB_HEADER_I32), interrupt: new AbortController() };
}

function threadCancel(thread: ThreadSignals): AbortSignal {
  return unblocked(thread.header) !== 0 ? AbortSignal.abort() : thread.interrupt.signal;
}

function notifiers(header: Int32Array): { onPending(sig: number): void; onAsync(): void } {
  return {
    onPending(sig) {
      Atomics.or(header, SAB_I_SIGNALS, sigbit(sig));
      Atomics.notify(header, SAB_I_SIGNALS);
    },
    onAsync() {
      Atomics.add(header, SAB_I_ASYNC, 1);
      Atomics.notify(header, SAB_I_ASYNC);
    },
  };
}

function publishStops(process: WasmProcess, header: Int32Array): void {
  process.onState((state) => {
    Atomics.store(header, SAB_I_STOP, state === 'stopped' ? 1 : 0);
    Atomics.notify(header, SAB_I_STOP);
  });
}

function transferOf(opts: SpawnWasmOptions, lane: JsLane | undefined): Transferable[] {
  const transfer: Transferable[] = opts.fork ? [opts.fork.memory.buffer as ArrayBuffer] : [];
  return lane ? [...transfer, lane.port] : transfer;
}

function openLane(
  token: string,
  dispatch: (req: SyncSabDispatchRequest) => Promise<SyncFsResult>
): { lane: JsLane; dispose(): void } {
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
  const { port1, port2 } = new MessageChannel();
  const responder = attachSyncSabResponder(port1, sab, token, { dispatch });
  port1.start();
  return {
    lane: { sab, port: port2 },
    dispose() {
      responder.dispose();
      port1.close();
    },
  };
}

function processInit(
  opts: SpawnWasmOptions,
  sab: SharedArrayBuffer,
  umask: number,
  cred: Cred,
  lane: JsLane | undefined
): ProcessInitMsg {
  const base = {
    type: WASM_PROCESS_INIT,
    pid: opts.shownPid ?? opts.pid,
    argv0: opts.argv0,
    args: opts.args,
    env: opts.env,
    cwd: opts.cwd,
    sab,
    umask,
    cred,
    ...(opts.changes ? { changes: opts.changes } : {}),
    ...(opts.owners ? { owners: true } : {}),
    ...(opts.links !== undefined ? { links: true } : {}),
    ...(opts.ppid !== undefined ? { ppid: opts.ppid } : {}),
  } as const;
  if (opts.program.abi === 'js') {
    return {
      ...base,
      program: opts.program,
      fds: inheritedFds(opts.fds),
      lane,
    };
  }
  return {
    ...base,
    program: opts.program,
    ...(opts.fork ? { fork: opts.fork } : { fds: inheritedFds(opts.fds) }),
  };
}

function inherited(opts: SpawnWasmOptions): { ignored?: number; umask?: number; cred?: Cred } {
  return {
    ...(opts.ignored ? { ignored: opts.ignored } : {}),
    ...(opts.umask !== undefined ? { umask: opts.umask } : {}),
    ...(opts.cred ? { cred: opts.cred } : {}),
  };
}

function heldBy(process: WasmProcess, holds: HeldPaths, replacements?: Replacements): void {
  process.keptPath = (path) => holds.keptAt(path)?.hidden;
  process.keptHandle = (handle) => holds.keptFor(handle)?.hidden;
  process.holdsHandle = (handle) => holds.holdsHandle(handle);
  if (replacements) process.replacements = replacements;
}

function holdingToken(
  opts: SpawnWasmOptions,
  holds: HeldPaths,
  caller: {
    cred: () => Cred;
    umask: () => number;
    created: Created;
    holdsKept: (path: string) => Promise<boolean>;
  }
): string {
  return mintSyncFsToken({
    ...(opts.owners ? caller : { umask: caller.umask }),
    ...(opts.dac ? { dac: opts.dac, pid: opts.pid, created: caller.created } : {}),
    ...(opts.links !== undefined ? { links: opts.links } : {}),
    ...(opts.fresh ? { fresh: (path: string) => opts.fresh?.(path, caller.umask()) } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.replacements ? { replacements: opts.replacements } : {}),
    fs: opts.fs,
    noLinks: opts.noLinks,
    cwd: opts.cwd,
    ...(opts.statfs ? { statfs: opts.statfs } : {}),
    hold: (path, on, open, real, handle) => holds.hold(path, on, open, real, handle),
    keptFor: (handle) => holds.keptFor(handle),
    unlinked: (path) => holds.keptAt(path),
    gate: (path, op) =>
      opts.unlinkGate && holds.holding(path) ? opts.unlinkGate.run(holds.keyOf(path), op) : op(),
    own: (path, op) => holds.own(path, op),
    revoked: (path) => holds.isRevoked(path),
    renamed: (from, to) => holds.renamed(from, to),
  });
}

function linksOf(opts: SpawnWasmOptions): { links?: number } {
  return opts.links === undefined ? {} : { links: opts.links };
}

function clipboardName(opts: SpawnWasmOptions): { clipboardName?: string } {
  return opts.program.abi === 'js' ? {} : { clipboardName: opts.argv0 };
}

function processOptions(
  opts: SpawnWasmOptions,
  header: Int32Array,
  hooks: Pick<
    WasmProcessOptions,
    'raise' | 'threadKill' | 'unblockedThread' | 'exitNow' | 'exitSignal'
  >,
  created: Created
): WasmProcessOptions {
  return {
    ...inherited(opts),
    ...(opts.owners ? { owners: true } : {}),
    ...(opts.sealed ? { sealed: opts.sealed } : {}),
    ...(opts.outputFilter ? { outputFilter: opts.outputFilter } : {}),
    ...(opts.clipboard ? { clipboard: opts.clipboard, ...clipboardName(opts) } : {}),
    ...(opts.readonlyAt ? { readonlyAt: opts.readonlyAt } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    noLinks: opts.noLinks,
    ...(opts.dac ? { guard: { dac: opts.dac, fs: opts.fs, created, ...linksOf(opts) } } : {}),
    ...(opts.identity ? { identity: opts.identity } : {}),
    ...(opts.onSyscall ? { onSyscall: opts.onSyscall } : {}),
    ...(opts.settling ? { settling: opts.settling } : {}),
    spawner: opts.spawner,
    forker: opts.forker,
    ...(opts.fork?.dl ? { dl: opts.fork.dl } : {}),
    fs: opts.fs,
    kill: opts.kill,
    ...(opts.writesBack ? { writesBack: opts.writesBack } : {}),
    processes: opts.processes,
    ...(opts.sudo ? { sudo: opts.sudo } : {}),
    ...(opts.crontab ? { crontab: opts.crontab } : {}),
    openFiles: opts.openFiles,
    ...(opts.nodes ? { nodes: opts.nodes } : {}),
    mounts: opts.mounts,
    ...(opts.mount ? { mount: opts.mount } : {}),
    ...(opts.umount ? { umount: opts.umount } : {}),
    jobs: opts.jobs,
    ptys: opts.ptys,
    net: opts.net,
    http: opts.http,
    locks: opts.locks,
    fifos: opts.fifos,
    ...(opts.sems ? { sems: opts.sems } : {}),
    watches: opts.watches,
    onReap: opts.onReap,
    resolver: opts.resolver,
    ...notifiers(header),
    onTimer: (which) => void Atomics.or(header, SAB_I_TIMERS, 1 << which),
    hasPending: () => unblocked(header) !== 0 || Atomics.load(header, SAB_I_TIMERS) !== 0,
    raise: hooks.raise,
    threadKill: hooks.threadKill,
    unblockedThread: hooks.unblockedThread,
    ...(hooks.exitNow ? { exitNow: hooks.exitNow } : {}),
    ...(hooks.exitSignal ? { exitSignal: hooks.exitSignal } : {}),
    ...(opts.program.abi === 'wasi' || opts.program.abi === 'js'
      ? { pendingBits: () => Atomics.load(header, SAB_I_SIGNALS) }
      : {}),
    ...(opts.program.abi === 'wasi'
      ? { blockedBits: () => Atomics.load(header, SAB_I_BLOCKED) }
      : {}),
  };
}

function threadInit(
  opts: SpawnWasmOptions,
  program: WasmThreadInitMsg['program'],
  sab: SharedArrayBuffer,
  cred: WasmProcess['cred'],
  thread: WasmThread,
  main: SharedArrayBuffer
): WasmThreadInitMsg {
  return {
    type: WASM_THREAD_INIT,
    pid: opts.shownPid ?? opts.pid,
    program,
    argv0: opts.argv0,
    args: opts.args,
    env: opts.env,
    cwd: opts.cwd,
    sab,
    cred: copyCred(cred),
    owners: opts.owners === true,
    ...(opts.links !== undefined ? { links: true } : {}),
    ...(opts.ppid !== undefined ? { ppid: opts.ppid } : {}),
    thread,
    signals: main,
  };
}

function settleExit(exit: Promise<unknown>, settle: (status: number) => void, code: number) {
  void exit.catch(() => undefined).then(() => settle(code & 0xff));
}

function readiness(abi: string | undefined): PromiseWithResolvers<boolean> {
  const ready = Promise.withResolvers<boolean>();
  if (abi === 'js') ready.resolve(true);
  return ready;
}

function outOfMemory(opts: SpawnWasmOptions, data: WorkerSays | undefined): boolean {
  if (data?.type !== WASM_PROCESS_ERROR || !WASM_OOM.test(String(data.message))) return false;
  if (!opts.onOom?.()) {
    opts.onError?.(
      `${opts.argv0}: cannot allocate memory for a new process (too many processes at once)`
    );
  }
  return true;
}

export function spawnWasmProcess(opts: SpawnWasmOptions): WasmProcessHandle {
  const { promise: ready, resolve: started } = readiness(opts.program.abi);
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
  const header = new Int32Array(sab, 0, SAB_HEADER_I32);
  const blocked = opts.fork?.wasi?.blocked ?? opts.blocked;
  if (blocked && anyBlocked(blocked) && opts.program.abi === 'wasi') storeBlocked(header, blocked);
  const threadSignals = new Map<number, ThreadSignals>();
  const created = new Created();
  const process: WasmProcess = new WasmProcess(
    opts.pid,
    opts.fds,
    processOptions(
      opts,
      header,
      {
        raise: (sig, info) => signal(sig, info),
        threadKill: (tid, sig) =>
          killThread(threadSignals.get(tid), process.signalMasks().caught, sig),
        unblockedThread: (sig) => unblockedThread(threadSignals, sig),
        ...(opts.program.abi === 'js'
          ? {
              exitNow: (code: number) => exitNow(code),
              exitSignal: (sig: number) => queueMicrotask(() => finish(128 + sig, sig)),
            }
          : { exitSignal: (sig: number) => terminate(128 + sig, sig) }),
      },
      created
    )
  );
  publishStops(process, header);
  const holds = new HeldPaths();
  opts.held?.add(holds);
  const token = holdingToken(opts, holds, {
    cred: () => process.cred,
    umask: () => process.umask,
    created,
    holdsKept: async (path) =>
      path.includes(`/${UNLINKED_DIR}/`) && (holds.keeps(path) || (await process.holds(path))),
  });
  heldBy(process, holds, opts.replacements);
  const worker = opts.createWorker();
  const dying = new Dying();
  const dispatch = (req: SyncSabDispatchRequest, block?: () => void): Promise<SyncFsResult> =>
    dying.serve(req, () =>
      isWasmSyscall(req) ? process.syscall(req, undefined, block) : dispatchSyncFs(req)
    );
  const clocks = new ProcessClocks(sab, opts.program.abi !== 'js', process);
  const responder = attachSyncSabResponder(worker, sab, token, {
    dispatch: clocks.timed(undefined, dispatch),
  });
  const lane = opts.program.abi === 'js' ? openLane(token, dispatch) : undefined;

  const { promise: exited, resolve: settle } = Promise.withResolvers<number>();
  let done = false;
  let endedBy: number | undefined;

  const finish = (code: number, sig?: number): void => {
    if (done) return;
    done = true;
    started(true);
    clocks.freeze();
    dying.clear();
    endedBy = sig ?? process.execTermsig;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    for (const tid of [...threads.keys()]) endThread(tid);
    responder.dispose();
    lane?.dispose();
    revokeSyncFsToken(token);
    opts.held?.delete(holds);
    worker.terminate();
    settleExit(process.exit(), settle, code);
  };
  const exitNow = (code: number): void => {
    queueMicrotask(() => finish(...dying.status(code)));
  };
  const handle = (data: WorkerSays | undefined): void => {
    if (data?.type === WASM_PROCESS_READY) {
      started(true);
    } else if (outOfMemory(opts, data)) {
      started(false);
      finish(NO_MEMORY);
    } else if (data?.type === WASM_PROCESS_EXIT) {
      finish(...dying.status(data.code));
    } else if (data?.type === WASM_PROCESS_ERROR) {
      if (!dying.ending) opts.onError?.(String(data.message));
      finish(...dying.status(data.code));
    } else if (data?.type === WASM_THREAD_SPAWN && data.thread) {
      spawnThread(data.thread);
    }
  };
  const onMessage = (event: MessageEvent): void => handle(event.data as WorkerSays | undefined);
  const onError = (event: MessageEvent): void => {
    event.preventDefault();
    opts.onError?.(String((event as unknown as ErrorEvent).message ?? 'worker error'));
    finish(CRASHED);
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  const threads = new Map<number, () => void>();
  const endThread = (tid: number): void => {
    const end = threads.get(tid);
    threads.delete(tid);
    clocks.threadEnded(tid);
    process.threadEnded(tid);
    end?.();
  };
  const spawnThread = (thread: WasmThread): void => {
    const { program } = opts;
    if (done || program.abi === 'js') return;
    if (threads.size >= WASM_MAX_THREADS - 1) {
      opts.onError?.(`more than ${WASM_MAX_THREADS} threads`);
      finish(CRASHED);
      return;
    }
    const tsab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
    const tw = opts.createWorker();
    const tsignals = threadSignalsOf(tsab);
    if (thread.blocked) storeBlocked(tsignals.header, thread.blocked);
    threadSignals.set(thread.tid, tsignals);
    const tdispatch = (req: SyncSabDispatchRequest, block: () => void) =>
      dying.serve(req, () => threadCall(process, req, threadCancel(tsignals), block));
    const tresponder = attachSyncSabResponder(tw, tsab, token, {
      dispatch: clocks.timed(clocks.thread(thread.tid, tsab), tdispatch),
    });
    const onThreadMessage = (event: MessageEvent): void => {
      const data = event.data as WorkerSays | undefined;
      if (data?.type === WASM_THREAD_EXIT) endThread(thread.tid);
      else handle(data);
    };
    tw.addEventListener('message', onThreadMessage);
    tw.addEventListener('error', onError);
    threads.set(thread.tid, () => {
      threadSignals.delete(thread.tid);
      tw.removeEventListener('message', onThreadMessage);
      tw.removeEventListener('error', onError);
      tresponder.dispose();
      tw.terminate();
    });
    tw.postMessage(threadInit(opts, program, tsab, process.cred, thread, sab));
  };
  worker.postMessage(
    processInit(opts, sab, process.umask, copyCred(process.cred), lane?.lane),
    transferOf(opts, lane?.lane)
  );
  const terminate = (code: number, sig: number): void => {
    if (opts.program.abi !== 'wasi' || done) finish(code, sig);
    else dying.start(code, sig, header, process, () => finish(code, sig));
  };
  const signal = (sig: number, info?: SigInfo): void => {
    if (process.signal(sig, info) === 'terminate')
      terminate(sig === SIG.KILL ? 137 : 128 + sig, sig);
  };
  const kill = (code = 137): void =>
    finish(code, code > 128 && code < 160 ? code - 128 : undefined);
  return {
    pid: opts.pid,
    exited,
    ready,
    kill,
    signal,
    termsig: () => endedBy,
    onState: (listener) => process.onState(listener),
    memory: () => Atomics.load(header, SAB_I_MEMORY) * 65536,
    ignoredSignals: (fork) => process.inheritable(fork),
    blockedSignals: () => (opts.program.abi === 'wasi' ? loadBlocked(header) : [0, 0]),
    signalMasks: () => process.signalMasks(),
    umask: () => process.umask,
    cred: () => copyCred(process.cred),
    writesBack: () => opts.program.abi === 'wasi' && !done,
    ...clockViews(clocks),
  };
}

function clockViews(
  clocks: ProcessClocks
): Pick<WasmProcessHandle, 'times' | 'running' | 'threads'> {
  return {
    times: () => clocks.times(),
    running: () => clocks.running(),
    threads: () => clocks.states(),
  };
}
