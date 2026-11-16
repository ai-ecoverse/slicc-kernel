import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_THREAD_INIT,
  WASM_THREAD_SPAWN,
  type WasmProcessErrorMsg,
  type WasmProcessExitMsg,
  type WasmProcessInitMsg,
  type WasmThread,
  type WasmThreadInitMsg,
} from '../kernel/protocol.ts';
import { runEmscriptenProcess } from '../process/emscripten/runtime.ts';
import { rawStack } from '../process/raw-stack.ts';
import type { CreateImports } from '../process/wasi/wasi-imports.ts';
import {
  runWasiProcess,
  runWasiThread,
  type TransportFactory,
} from '../process/wasi/wasi-runtime.ts';
import type { SabPostLike, SyncSabTransport } from '../realm/sync-sab-bridge.ts';
import { asyncFutexes, FutexHub } from './futexes.ts';
import { type AsyncWaiter, jspiAvailable, localWaiter, registerWaiter } from './jspi.ts';
import type { KernelLink } from './link.ts';
import type { ForkSnapshots } from './snapshots.ts';
import { type AsyncTransport, createAsyncTransport } from './transport.ts';
import {
  ASYNC_THREAD,
  type AsyncInit,
  type AsyncProcessInit,
  type AsyncThreadInit,
  isThreadMsg,
} from './wire.ts';

export type ImportsNamespace = Record<string, unknown>;

export interface AsyncProcessEntryDeps {
  module(image: string): WebAssembly.Module | Promise<WebAssembly.Module>;
  imports?(source: string): ImportsNamespace | Promise<ImportsNamespace>;
  maxMessageBytes?: number;
  snapshots?: ForkSnapshots;
  deadlines?: boolean;
}

const NOT_RUNNABLE = 126;

export const ASYNC_NO_JSPI =
  'the async process host needs WebAssembly JSPI (Suspending, promising)';
export const ASYNC_NO_JS = 'the async process host runs no JavaScript programs';
export const ASYNC_NO_EMSCRIPTEN =
  "the async process host runs Emscripten programs only on the kernel's personality (emscripten: 'kernel')";
export const ASYNC_NO_IMPORTS = 'the async process host loads no JavaScript imports modules';
export const ASYNC_LOST_THREAD = 'the async process host has no memory for this thread';
export const ASYNC_NO_CREATE =
  'the imports module exports no createAsyncImports function, which the async process host calls';

function refusal(init: AsyncInit, deps: AsyncProcessEntryDeps): string | undefined {
  const program = init.program as Omit<AsyncProcessInit['program'], 'abi'> & { abi?: string };
  if (program.abi === 'js') return ASYNC_NO_JS;
  if (program.abi !== 'wasi' && program.emscripten !== 'kernel') return ASYNC_NO_EMSCRIPTEN;
  if (program.imports !== undefined && !deps.imports) return ASYNC_NO_IMPORTS;
  if (!jspiAvailable()) return ASYNC_NO_JSPI;
  return undefined;
}

class NotRunnable extends Error {}

async function importsOf(
  init: AsyncInit,
  deps: AsyncProcessEntryDeps
): Promise<CreateImports | undefined> {
  const source = init.program.imports;
  if (source === undefined || !deps.imports) return undefined;
  const create = (await deps.imports(source)).createAsyncImports;
  if (typeof create !== 'function') throw new NotRunnable(ASYNC_NO_CREATE);
  return create as CreateImports;
}

export class KernelGone extends Error {
  constructor() {
    super('the kernel link closed');
  }
}

function guarded(transport: AsyncTransport): SyncSabTransport {
  const call = async (...args: Parameters<AsyncTransport['call']>) => {
    if (transport.closed) throw new KernelGone();
    try {
      return await transport.call(...args);
    } catch (err) {
      if (transport.closed) throw new KernelGone();
      throw err;
    }
  };
  return { call, publish: () => transport.publish() } as unknown as SyncSabTransport;
}

export const KERNEL_WAIT = 'kernel-wait';

export function kernelWaiter(
  transport: Pick<AsyncTransport, 'wait'>,
  kernel: Pick<SyncSabTransport, 'call'>,
  mirrored: boolean
): AsyncWaiter {
  return async (view, index, value, timeout = Number.POSITIVE_INFINITY) => {
    if (Atomics.load(view, index) !== value) return 'not-equal';
    if (timeout <= 0) return 'timed-out';
    const forever = !Number.isFinite(timeout);
    if (forever && mirrored) return transport.wait(view, index, value);
    const timeoutMs = forever ? -1 : Math.max(1, Math.ceil(timeout));
    await kernel.call({ op: 'fd-select', read: [], write: [], timeoutMs }, Infinity, KERNEL_WAIT);
    return forever || Atomics.load(view, index) !== value ? 'ok' : 'timed-out';
  };
}

function waitsOn(waiter: AsyncWaiter, buffer: ArrayBufferLike | undefined): void {
  if (buffer) registerWaiter(buffer, waiter);
}

type LocalThread = Pick<WasmThread, 'memory' | 'ids' | 'modules'>;

export class ProcessThreads {
  readonly hub = new FutexHub();
  main: AsyncTransport | undefined;
  private readonly spawned = new Map<number, LocalThread>();

  outgoing(message: unknown): unknown {
    const data = message as { type?: unknown; thread?: WasmThread } | undefined;
    if (data?.type !== WASM_THREAD_SPAWN || !data.thread) return message;
    const { memory, ids, modules, ...shown } = data.thread;
    this.spawned.set(shown.tid, { memory, ids, ...(modules ? { modules } : {}) });
    registerWaiter(ids, localWaiter);
    return { ...data, thread: shown };
  }

  take(tid: number): LocalThread | undefined {
    const local = this.spawned.get(tid);
    this.spawned.delete(tid);
    return local;
  }
}

interface ChannelEnd {
  link: KernelLink;
  deliver(message: unknown): void;
  close(reason: string): void;
}

function channelEnd(root: KernelLink, channel: number, gone: () => void): ChannelEnd {
  const posts: Array<(message: unknown) => void> = [];
  const early: unknown[] = [];
  const closes: Array<(reason: string) => void> = [];
  let ended: string | undefined;
  const close = (reason: string): void => {
    if (ended !== undefined) return;
    ended = reason;
    gone();
    for (const handler of closes.splice(0)) handler(reason);
  };
  const link: KernelLink = {
    post(message, transfer) {
      if (ended === undefined) root.post({ type: ASYNC_THREAD, channel, message }, transfer);
    },
    call(message, transfer) {
      if (ended !== undefined) return Promise.reject(new Error(`link closed: ${ended}`));
      return root.call({ type: ASYNC_THREAD, channel, message }, transfer);
    },
    onMessage(handler) {
      posts.push(handler);
      for (const message of early.splice(0)) handler(message);
    },
    onClose(handler) {
      const reason = ended;
      if (reason === undefined) closes.push(handler);
      else queueMicrotask(() => handler(reason));
    },
    close: () => close('the thread closed its link'),
  };
  return {
    link,
    deliver(message) {
      if (posts.length === 0) early.push(message);
      else for (const handler of posts) handler(message);
    },
    close,
  };
}

export function threadMux(root: KernelLink, opened: (link: KernelLink) => void): KernelLink {
  const channels = new Map<number, ChannelEnd>();
  const posts: Array<(message: unknown) => void> = [];
  const early: unknown[] = [];
  root.onMessage((message) => {
    if (!isThreadMsg(message)) {
      if (posts.length === 0) early.push(message);
      else for (const handler of posts) handler(message);
      return;
    }
    const { channel } = message;
    let end = channels.get(channel);
    if (message.closed !== undefined) {
      end?.close(message.closed);
      return;
    }
    if (!end) {
      end = channelEnd(root, channel, () => channels.delete(channel));
      channels.set(channel, end);
      opened(end.link);
    }
    end.deliver(message.message);
  });
  root.onClose((reason) => {
    for (const end of [...channels.values()]) end.close(reason);
  });
  return {
    post: (message, transfer) => root.post(message, transfer),
    call: (message, transfer) => root.call(message, transfer),
    onMessage(handler) {
      posts.push(handler);
      for (const message of early.splice(0)) handler(message);
    },
    onClose: (handler) => root.onClose(handler),
    close: () => root.close(),
  };
}

function localInit(
  init: AsyncProcessInit,
  transport: AsyncTransport,
  module: WebAssembly.Module
): WasmProcessInitMsg {
  const { mirror: _mirror, maxMessageBytes: _max, held, program, ...rest } = init;
  const { image: _image, ...known } = program;
  const cwds = transport.cwds as unknown as SharedArrayBuffer | undefined;
  const changes = transport.changes as unknown as SharedArrayBuffer | undefined;
  return {
    ...rest,
    sab: transport.buffer as unknown as SharedArrayBuffer,
    ...(changes ? { changes } : {}),
    ...(held && cwds ? { held: { ...held, sab: cwds } } : {}),
    program: { ...known, module },
  } as WasmProcessInitMsg;
}

function threadInit(
  init: AsyncThreadInit,
  transport: AsyncTransport,
  module: WebAssembly.Module,
  local: LocalThread,
  main: AsyncTransport
): WasmThreadInitMsg {
  const { thread, ...shown } = init;
  const process = localInit(shown as unknown as AsyncProcessInit, transport, module);
  return {
    ...process,
    type: WASM_THREAD_INIT,
    thread: { ...thread, ...local },
    signals: main.buffer as unknown as SharedArrayBuffer,
  } as WasmThreadInitMsg;
}

interface Running {
  transport: AsyncTransport;
  kernel: SyncSabTransport;
  port: SabPostLike;
}

function running(transport: AsyncTransport, threads: ProcessThreads): Running {
  const kernel = guarded(transport);
  const mirrored = kernelWaiter(transport, kernel, true);
  waitsOn(mirrored, transport.buffer);
  waitsOn(mirrored, transport.changes);
  waitsOn(mirrored, transport.cwds);
  const port: SabPostLike = {
    postMessage: (message, transfer) => transport.post(threads.outgoing(message), transfer),
  };
  return { transport, kernel, port };
}

async function started(
  init: AsyncProcessInit,
  transport: AsyncTransport,
  deps: AsyncProcessEntryDeps,
  size: { memory: (() => number) | undefined },
  threads: ProcessThreads
): Promise<number> {
  const create = await importsOf(init, deps);
  const module = await deps.module(init.program.image);
  const { kernel, port } = running(transport, threads);
  const local = localInit(init, transport, module);
  const transports: TransportFactory = (_sab, _port, memory) => {
    size.memory = memory;
    return kernel;
  };
  if (local.program.abi !== 'wasi')
    return runEmscriptenProcess(local, port, { transport: transports });
  return runWasiProcess(local, port, {
    transport: transports,
    futexes: asyncFutexes(threads.hub, transport),
    ...(create ? { imports: create } : {}),
  });
}

export async function threadStarted(
  init: AsyncThreadInit,
  transport: AsyncTransport,
  deps: AsyncProcessEntryDeps,
  threads: ProcessThreads
): Promise<void> {
  const local = threads.take(init.thread.tid);
  const main = threads.main;
  if (!local || !main) throw new Error(ASYNC_LOST_THREAD);
  const create = await importsOf(init, deps);
  const module = await deps.module(init.program.image);
  const { kernel, port } = running(transport, threads);
  threads.hub.threads++;
  try {
    await runWasiThread(threadInit(init, transport, module, local, main), port, {
      transport: () => kernel,
      futexes: asyncFutexes(threads.hub, transport),
      ...(create ? { imports: create } : {}),
    });
  } finally {
    threads.hub.threads--;
  }
}

function failure(transport: AsyncTransport) {
  return (err: unknown, code?: number): void =>
    transport.post({
      type: WASM_PROCESS_ERROR,
      message: err instanceof Error ? (rawStack(err) ?? err.message) : String(err),
      ...(code === undefined ? {} : { code }),
    } satisfies WasmProcessErrorMsg);
}

export function asyncProcessEntry(link: KernelLink, deps: AsyncProcessEntryDeps): void {
  const size: { memory: (() => number) | undefined } = { memory: undefined };
  const threads = new ProcessThreads();
  const transportOf = (on: KernelLink) =>
    createAsyncTransport(on, {
      ...(deps.maxMessageBytes !== undefined ? { maxMessageBytes: deps.maxMessageBytes } : {}),
      ...(deps.snapshots ? { snapshots: deps.snapshots } : {}),
      ...(deps.deadlines === false ? { deadlines: false } : {}),
      memory: () => size.memory?.(),
    });
  const thread = (on: KernelLink): void => {
    const transport = transportOf(on);
    const failed = failure(transport);
    transport.init.then(
      (init) => {
        if (init.type !== WASM_THREAD_INIT) return failed(ASYNC_LOST_THREAD);
        threadStarted(init, transport, deps, threads).catch((err) => {
          if (!transport.closed) failed(err);
        });
      },
      () => undefined
    );
  };
  const transport = transportOf(threadMux(link, thread));
  threads.main = transport;
  const failed = failure(transport);
  transport.init.then(
    (init) => {
      const refused = refusal(init, deps);
      if (refused) return failed(refused, NOT_RUNNABLE);
      if (init.type === WASM_THREAD_INIT) return failed(ASYNC_LOST_THREAD);
      started(init, transport, deps, size, threads).then(
        (code) => transport.post({ type: WASM_PROCESS_EXIT, code } satisfies WasmProcessExitMsg),
        (err) => {
          if (transport.closed) return;
          if (err instanceof NotRunnable) failed(err.message, NOT_RUNNABLE);
          else failed(err);
        }
      );
    },
    () => undefined
  );
}
