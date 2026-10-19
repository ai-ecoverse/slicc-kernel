import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import type { SyncSabDispatchRequest } from '../realm/sync-sab-responder.ts';
import {
  SAB_DEFAULT_WINDOW_BYTES,
  SAB_HEADER_BYTES,
  SAB_HEADER_I32,
  SAB_I_STOP,
} from '../realm/sync-sab-wire.ts';
import type { CpuClock, ProcessClocks } from './cpu-clock.ts';
import type { WasmWorkerLike } from './host.ts';
import { isWasmSyscall } from './process.ts';
import {
  JS_DEFAULT_THREADS,
  JS_MAX_THREADS,
  JS_THREAD_CRASHED,
  JS_THREAD_EXIT,
  JS_THREAD_INIT,
  JS_THREAD_NO_MEMORY,
  JS_THREAD_SPAWN,
  type JsLane,
  type JsProcessInitMsg,
  type JsThreadControl,
  type JsThreadInitMsg,
  type JsThreadSpawnMsg,
  WASM_PROCESS_ERROR,
} from './protocol.ts';

export const JS_OOM =
  /out of memory|Array buffer allocation failed|Cannot allocate Wasm memory|could not allocate memory|ERR_WORKER_OUT_OF_MEMORY/i;

const ENDING: SyncFsResult = { ok: false, errno: 'EINTR', message: 'the thread is ending' };

const MAIN_ONLY: SyncFsResult = { ok: true, kind: 'void' };

type Tracked = { op: string; id?: unknown; token?: unknown };

function track(ops: Map<number, unknown>, req: Tracked, result: SyncFsResult): void {
  if (req.op === 'async-submit' && result.ok && result.kind === 'json') {
    if (typeof result.json === 'number') ops.set(result.json, req.token);
  } else if (
    req.op === 'async-cancel' ||
    (req.op === 'async-take' && (result.ok || result.errno !== 'EAGAIN'))
  ) {
    ops.delete(req.id as number);
  }
}

function cores(): number {
  const n = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

export function jsThreadCap(env: Readonly<Record<string, string>>): number {
  const asked = Number.parseInt(env.SLICC_JS_THREADS ?? '', 10);
  if (asked >= 1) return Math.min(asked, JS_MAX_THREADS);
  return Math.min(JS_MAX_THREADS, Math.max(JS_DEFAULT_THREADS, 2 * cores()));
}

type Dispatch = (req: SyncSabDispatchRequest, block?: () => void) => Promise<SyncFsResult>;

export interface JsThreadDeps {
  cap: number;
  wakes: Set<Int32Array>;
  createWorker: () => WasmWorkerLike;
  init: (sab: SharedArrayBuffer, lane: JsLane) => JsProcessInitMsg;
  openLane: (dispatch: Dispatch) => { lane: JsLane; dispose(): void };
  attach: (
    worker: WasmWorkerLike,
    sab: SharedArrayBuffer,
    dispatch: Dispatch
  ) => { dispose(): void };
  dispatch: Dispatch;
  clocks: Pick<ProcessClocks, 'thread' | 'threadEnded' | 'timed'>;
}

interface ThreadSays {
  type?: string;
  code?: unknown;
  message?: unknown;
}

function codeOf(code: unknown): number {
  if (code === JS_THREAD_NO_MEMORY || code === JS_THREAD_CRASHED) return code;
  return typeof code === 'number' && Number.isInteger(code) ? code & 0xff : JS_THREAD_CRASHED;
}

function answer(control: MessagePort, message: JsThreadControl): void {
  control.postMessage(message);
}

export class JsThreads {
  private readonly deps: JsThreadDeps;
  private readonly live = new Map<number, (code: number) => void>();
  private readonly headers = new Map<number, Int32Array>();
  private frozen = false;
  private last = 0;
  private closed = false;

  constructor(deps: JsThreadDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.live.size;
  }

  spawn(msg: JsThreadSpawnMsg): void {
    const { control, port } = msg;
    if (this.closed || this.live.size >= this.deps.cap) {
      answer(
        control,
        this.closed
          ? { errno: 'ESRCH', message: 'the process is ending' }
          : { errno: 'EAGAIN', message: `more than ${this.deps.cap} threads` }
      );
      control.close();
      port.close();
      return;
    }
    const tid = ++this.last;
    const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
    const header = new Int32Array(sab, 0, SAB_HEADER_I32);
    if (this.frozen) Atomics.store(header, SAB_I_STOP, 1);
    const worker = this.deps.createWorker();
    const clock: CpuClock = this.deps.clocks.thread(tid + 1, sab);
    let ended = false;
    const end = (code: number): void => {
      if (ended) return;
      ended = true;
      this.live.delete(tid);
      this.headers.delete(tid);
      this.deps.wakes.delete(header);
      for (const [id, token] of ops) {
        void this.deps.dispatch({ op: 'async-cancel', id, token } as SyncSabDispatchRequest);
      }
      ops.clear();
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      control.removeEventListener('message', onControl);
      responder.dispose();
      lane.dispose();
      this.deps.clocks.threadEnded(tid + 1);
      worker.terminate();
      answer(control, { exited: code });
      control.close();
    };
    const ops = new Map<number, unknown>();
    const dispatch: Dispatch = async (req, block) => {
      if (isWasmSyscall(req) && req.op === 'proc-exit') {
        queueMicrotask(() => end(req.status & 0xff));
        return ENDING;
      }
      if (isWasmSyscall(req) && req.op === 'sig-mask') return MAIN_ONLY;
      const result = await this.deps.dispatch(req, block);
      if (!ended) track(ops, req as Tracked, result);
      return result;
    };
    const responder = this.deps.attach(worker, sab, this.deps.clocks.timed(clock, dispatch));
    const lane = this.deps.openLane(dispatch);
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as ThreadSays | undefined;
      if (data?.type === JS_THREAD_EXIT) end(codeOf(data.code));
      else if (data?.type === JS_THREAD_SPAWN) this.spawn(event.data as JsThreadSpawnMsg);
      else if (data?.type === WASM_PROCESS_ERROR) this.crashed(String(data.message), end);
    };
    const onError = (event: MessageEvent): void => {
      event.preventDefault();
      this.crashed(String((event as unknown as ErrorEvent).message ?? 'worker error'), end);
    };
    const onControl = (event: MessageEvent): void => {
      if ((event.data as { terminate?: unknown } | undefined)?.terminate === true) end(1);
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    control.addEventListener('message', onControl);
    control.start();
    this.live.set(tid, end);
    this.headers.set(tid, header);
    this.deps.wakes.add(header);
    const init: JsThreadInitMsg = {
      ...this.deps.init(sab, lane.lane),
      type: JS_THREAD_INIT,
      thread: { tid, port, data: msg.data },
    };
    try {
      worker.postMessage(init, [lane.lane.port, port, ...(msg.transfer ?? [])]);
    } catch {
      end(JS_THREAD_CRASHED);
      return;
    }
    answer(control, { tid });
  }

  private crashed(message: string, end: (code: number) => void): void {
    end(JS_OOM.test(message) ? JS_THREAD_NO_MEMORY : JS_THREAD_CRASHED);
  }

  stopped(stopped: boolean): void {
    this.frozen = stopped;
    for (const header of this.headers.values()) {
      Atomics.store(header, SAB_I_STOP, stopped ? 1 : 0);
      Atomics.notify(header, SAB_I_STOP);
    }
  }

  close(): void {
    this.closed = true;
    for (const end of [...this.live.values()]) end(1);
  }
}
