import { HeldPaths } from '../mount/mount-fs.ts';
import { dispatchSyncFs } from '../realm/sync-fs-dispatch.ts';
import {
  mintSyncFsToken,
  revokeSyncFsToken,
  type SyncFsTokenEntry,
} from '../realm/sync-fs-token-registry.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import {
  attachSyncSabResponder,
  type SyncSabDispatchRequest,
} from '../realm/sync-sab-responder.ts';
import {
  SAB_DEFAULT_WINDOW_BYTES,
  SAB_HEADER_BYTES,
  SAB_HEADER_I32,
  SAB_I_MEMORY,
  SAB_I_SIGNALS,
  SAB_I_TIMERS,
} from '../realm/sync-sab-wire.ts';
import type { ChildForker, ChildSpawner } from './children.ts';
import { type FdTable, kernelFdKind, type OpenFile } from './fd-table.ts';
import type { LockTable } from './host-ops.ts';
import type { JobTable } from './jobs.ts';
import type { HttpHandles } from './net/http-syscalls.ts';
import type { MountLine, ProcessListing } from './proc-info.ts';
import {
  isWasmSyscall,
  type StateListener,
  WasmProcess,
  type WasmProcessOptions,
} from './process.ts';
import {
  type ForkState,
  type InheritedFd,
  WASM_MAX_THREADS,
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  WASM_THREAD_EXIT,
  WASM_THREAD_INIT,
  WASM_THREAD_SPAWN,
  type WasmProcessInitMsg,
  type WasmProgram,
  type WasmThread,
  type WasmThreadInitMsg,
} from './protocol.ts';
import type { PtyTable } from './pty.ts';
import { SIG, sigbit } from './signals.ts';
import { KernelSocket, type LoopbackNet } from './socket.ts';
import type { VfsNodes } from './vfs-file.ts';

export interface WasmWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message' | 'error', handler: (event: MessageEvent) => void): void;
  terminate(): void;
}

export interface SpawnWasmOptions {
  pid: number;
  ignored?: number;
  program: WasmProgram;
  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  fds: FdTable;
  fs: SyncFsTokenEntry['fs'];
  createWorker: () => WasmWorkerLike;
  onError?: (message: string) => void;
  spawner?: ChildSpawner;
  forker?: ChildForker;
  fork?: ForkState;
  ppid?: number;

  shownPid?: number;
  kill?: (pid: number, sig: number) => boolean | Promise<boolean>;
  processes?: () => ProcessListing;
  openFiles?: Set<VfsNodes>;
  nodes?: VfsNodes;
  statfs?: (path: string) => Promise<{ quota: number; usage: number } | undefined>;
  mounts?: () => MountLine[];
  mount?: WasmProcessOptions['mount'];
  umount?: WasmProcessOptions['umount'];
  held?: Set<HeldPaths>;
  jobs?: JobTable;
  ptys?: PtyTable;

  net?: LoopbackNet;

  http?: HttpHandles;
  locks?: LockTable;
  onReap?: (pid: number) => void;
}

export interface WasmProcessHandle {
  pid: number;
  exited: Promise<number>;
  kill(code?: number): void;
  signal(sig: number): void;
  termsig(): number | undefined;
  onState(listener: StateListener): void;
  memory(): number;
  ignoredSignals(fork?: boolean): number;
}

const CRASHED = 70;

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
      const kind = open.file instanceof KernelSocket ? 'socket' : kernelFdKind(open.file);
      const meta = open.file.heldMeta;
      return {
        fd,
        kind,
        ...(kind === 'device' && meta && 'device' in meta ? { device: meta } : {}),
        ...(flags !== undefined ? { flags } : {}),
        ...(fds.closesOnExec(fd) ? { cloexec: true } : {}),
        ...(kind === 'stream' ? { desc: descId(open) } : {}),
      };
    });
}

interface WorkerSays {
  type?: string;
  code?: unknown;
  message?: unknown;
  thread?: WasmThread;
}

export function spawnWasmProcess(opts: SpawnWasmOptions): WasmProcessHandle {
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
  const header = new Int32Array(sab, 0, SAB_HEADER_I32);
  const process = new WasmProcess(opts.pid, opts.fds, {
    ...(opts.ignored ? { ignored: opts.ignored } : {}),
    spawner: opts.spawner,
    forker: opts.forker,
    fs: opts.fs,
    kill: opts.kill,
    processes: opts.processes,
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
    onReap: opts.onReap,
    onPending: (sig) => void Atomics.or(header, SAB_I_SIGNALS, sigbit(sig)),
    onTimer: (which) => void Atomics.or(header, SAB_I_TIMERS, 1 << which),
    hasPending: () =>
      Atomics.load(header, SAB_I_SIGNALS) !== 0 || Atomics.load(header, SAB_I_TIMERS) !== 0,
    raise: (sig) => signal(sig),
    ...(opts.program.abi === 'wasi'
      ? { pendingBits: () => Atomics.load(header, SAB_I_SIGNALS) }
      : {}),
  });
  const holds = new HeldPaths();
  opts.held?.add(holds);
  const token = mintSyncFsToken({
    fs: opts.fs,
    cwd: opts.cwd,
    ...(opts.statfs ? { statfs: opts.statfs } : {}),
    hold: (path, on) => holds.hold(path, on),
    revoked: (path) => holds.isRevoked(path),
    renamed: (from, to) => holds.renamed(from, to),
  });
  const worker = opts.createWorker();
  const dispatch = async (req: SyncSabDispatchRequest): Promise<SyncFsResult> => {
    if (isWasmSyscall(req)) return process.syscall(req);
    return dispatchSyncFs(req);
  };
  const responder = attachSyncSabResponder(worker, sab, token, { dispatch });

  let settle!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (settle = resolve));
  let done = false;
  let endedBy: number | undefined;

  const finish = (code: number, sig?: number): void => {
    if (done) return;
    done = true;
    endedBy = sig ?? process.execTermsig;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    for (const tid of [...threads.keys()]) endThread(tid);
    responder.dispose();
    revokeSyncFsToken(token);
    opts.held?.delete(holds);
    worker.terminate();
    void process.exit().then(
      () => settle(code),
      () => settle(code)
    );
  };

  const handle = (data: WorkerSays | undefined): void => {
    if (data?.type === WASM_PROCESS_EXIT) {
      finish(typeof data.code === 'number' ? data.code : CRASHED);
    } else if (data?.type === WASM_PROCESS_ERROR) {
      opts.onError?.(String(data.message));
      finish(CRASHED);
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
    end?.();
  };
  const spawnThread = (thread: WasmThread): void => {
    if (done) return;
    if (threads.size >= WASM_MAX_THREADS - 1) {
      opts.onError?.(`more than ${WASM_MAX_THREADS} threads`);
      finish(CRASHED);
      return;
    }
    const tsab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
    const tw = opts.createWorker();
    const tresponder = attachSyncSabResponder(tw, tsab, token, { dispatch });
    const onThreadMessage = (event: MessageEvent): void => {
      const data = event.data as WorkerSays | undefined;
      if (data?.type === WASM_THREAD_EXIT) endThread(thread.tid);
      else handle(data);
    };
    tw.addEventListener('message', onThreadMessage);
    tw.addEventListener('error', onError);
    threads.set(thread.tid, () => {
      tw.removeEventListener('message', onThreadMessage);
      tw.removeEventListener('error', onError);
      tresponder.dispose();
      tw.terminate();
    });
    const tinit: WasmThreadInitMsg = {
      type: WASM_THREAD_INIT,
      pid: opts.shownPid ?? opts.pid,
      program: opts.program,
      argv0: opts.argv0,
      args: opts.args,
      env: opts.env,
      cwd: opts.cwd,
      sab: tsab,
      ...(opts.ppid !== undefined ? { ppid: opts.ppid } : {}),
      thread,
    };
    tw.postMessage(tinit);
  };

  const init: WasmProcessInitMsg = {
    type: WASM_PROCESS_INIT,
    pid: opts.shownPid ?? opts.pid,
    program: opts.program,
    argv0: opts.argv0,
    args: opts.args,
    env: opts.env,
    cwd: opts.cwd,
    sab,
    ...(opts.ppid !== undefined ? { ppid: opts.ppid } : {}),
    ...(opts.fork ? { fork: opts.fork } : { fds: inheritedFds(opts.fds) }),
  };
  worker.postMessage(init, opts.fork ? [opts.fork.memory.buffer as ArrayBuffer] : []);

  const signal = (sig: number): void => {
    if (process.signal(sig) === 'terminate') finish(sig === SIG.KILL ? 137 : 128 + sig, sig);
  };
  const kill = (code = 137): void =>
    finish(code, code > 128 && code < 160 ? code - 128 : undefined);
  return {
    pid: opts.pid,
    exited,
    kill,
    signal,
    termsig: () => endedBy,
    onState: (listener) => process.onState(listener),
    memory: () => Atomics.load(header, SAB_I_MEMORY) * 65536,
    ignoredSignals: (fork) => process.inheritable(fork),
  };
}
