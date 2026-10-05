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
  SAB_I_SIGNALS,
  SAB_I_TIMERS,
} from '../realm/sync-sab-wire.ts';
import type { ChildForker, ChildSpawner } from './children.ts';
import { type FdTable, kernelFdKind, type OpenFile } from './fd-table.ts';
import type { JobTable } from './jobs.ts';
import { isWasmSyscall, type StateListener, WasmProcess } from './process.ts';
import {
  type ForkState,
  type InheritedFd,
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  type WasmProcessInitMsg,
  type WasmProgram,
} from './protocol.ts';
import type { PtyTable } from './pty.ts';
import { SIG, sigbit } from './signals.ts';

export interface WasmWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message' | 'error', handler: (event: MessageEvent) => void): void;
  terminate(): void;
}

export interface SpawnWasmOptions {
  pid: number;
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
  kill?: (pid: number, sig: number) => boolean | Promise<boolean>;
  jobs?: JobTable;
  ptys?: PtyTable;
}

export interface WasmProcessHandle {
  pid: number;
  exited: Promise<number>;
  kill(code?: number): void;
  signal(sig: number): void;
  termsig(): number | undefined;
  onState(listener: StateListener): void;
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
      const kind = kernelFdKind(open.file);
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
}

export function spawnWasmProcess(opts: SpawnWasmOptions): WasmProcessHandle {
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
  const header = new Int32Array(sab, 0, SAB_HEADER_I32);
  const process = new WasmProcess(opts.pid, opts.fds, {
    spawner: opts.spawner,
    forker: opts.forker,
    fs: opts.fs,
    kill: opts.kill,
    jobs: opts.jobs,
    ptys: opts.ptys,
    onPending: (sig) => void Atomics.or(header, SAB_I_SIGNALS, sigbit(sig)),
    onTimer: (which) => void Atomics.or(header, SAB_I_TIMERS, 1 << which),
    hasPending: () =>
      Atomics.load(header, SAB_I_SIGNALS) !== 0 || Atomics.load(header, SAB_I_TIMERS) !== 0,
    raise: (sig) => signal(sig),
  });
  const token = mintSyncFsToken({ fs: opts.fs, cwd: opts.cwd });
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
    responder.dispose();
    revokeSyncFsToken(token);
    worker.terminate();
    void process.exit().then(
      () => settle(code),
      () => settle(code)
    );
  };

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as WorkerSays | undefined;
    if (data?.type === WASM_PROCESS_EXIT) {
      finish(typeof data.code === 'number' ? data.code : CRASHED);
    } else if (data?.type === WASM_PROCESS_ERROR) {
      opts.onError?.(String(data.message));
      finish(CRASHED);
    }
  };
  const onError = (event: MessageEvent): void => {
    event.preventDefault();
    opts.onError?.(String((event as unknown as ErrorEvent).message ?? 'worker error'));
    finish(CRASHED);
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);

  const init: WasmProcessInitMsg = {
    type: WASM_PROCESS_INIT,
    pid: opts.pid,
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
  };
}
