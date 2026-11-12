import type { WasmProcessInitMsg } from '../kernel/protocol.ts';
import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  type WasmProcessErrorMsg,
  type WasmProcessExitMsg,
} from '../kernel/protocol.ts';
import { runEmscriptenProcess } from '../process/emscripten/runtime.ts';
import { rawStack } from '../process/raw-stack.ts';
import { runWasiProcess, type TransportFactory } from '../process/wasi/wasi-runtime.ts';
import type { SabPostLike, SyncSabTransport } from '../realm/sync-sab-bridge.ts';
import { type AsyncWaiter, jspiAvailable, registerMemoryWaiter, registerWaiter } from './jspi.ts';
import type { KernelLink } from './link.ts';
import type { ForkSnapshots } from './snapshots.ts';
import { type AsyncTransport, createAsyncTransport } from './transport.ts';
import type { AsyncProcessInit } from './wire.ts';

export interface AsyncProcessEntryDeps {
  module(image: string): WebAssembly.Module | Promise<WebAssembly.Module>;
  maxMessageBytes?: number;
  snapshots?: ForkSnapshots;
}

const NOT_RUNNABLE = 126;

export const ASYNC_NO_JSPI =
  'the async process host needs WebAssembly JSPI (Suspending, promising)';
export const ASYNC_NO_JS = 'the async process host runs no JavaScript programs';
export const ASYNC_NO_EMSCRIPTEN =
  "the async process host runs Emscripten programs only on the kernel's personality (emscripten: 'kernel')";
export const ASYNC_NO_IMPORTS = 'the async process host loads no JavaScript imports modules';

function refusal(init: AsyncProcessInit): string | undefined {
  const program = init.program as Omit<AsyncProcessInit['program'], 'abi'> & { abi?: string };
  if (program.abi === 'js') return ASYNC_NO_JS;
  if (program.abi !== 'wasi' && program.emscripten !== 'kernel') return ASYNC_NO_EMSCRIPTEN;
  if (program.imports !== undefined) return ASYNC_NO_IMPORTS;
  if (!jspiAvailable()) return ASYNC_NO_JSPI;
  return undefined;
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

async function started(
  init: AsyncProcessInit,
  transport: AsyncTransport,
  deps: AsyncProcessEntryDeps,
  size: { memory: (() => number) | undefined }
): Promise<number> {
  const module = await deps.module(init.program.image);
  const kernel = guarded(transport);
  const mirrored = kernelWaiter(transport, kernel, true);
  waitsOn(mirrored, transport.buffer);
  waitsOn(mirrored, transport.changes);
  waitsOn(mirrored, transport.cwds);
  const port: SabPostLike = {
    postMessage: (message, transfer) => transport.post(message, transfer),
  };
  const local = localInit(init, transport, module);
  const transports: TransportFactory = (_sab, _port, memory) => {
    size.memory = memory;
    return kernel;
  };
  if (local.program.abi !== 'wasi')
    return runEmscriptenProcess(local, port, { transport: transports });
  let forget = () => {};
  try {
    return await runWasiProcess(local, port, {
      transport: transports,
      threadCap: 1,
      bound: (memory) => {
        forget();
        forget = registerMemoryWaiter(memory, kernelWaiter(transport, kernel, false));
      },
    });
  } finally {
    forget();
  }
}

export function asyncProcessEntry(link: KernelLink, deps: AsyncProcessEntryDeps): void {
  const size: { memory: (() => number) | undefined } = { memory: undefined };
  const transport = createAsyncTransport(link, {
    ...(deps.maxMessageBytes !== undefined ? { maxMessageBytes: deps.maxMessageBytes } : {}),
    ...(deps.snapshots ? { snapshots: deps.snapshots } : {}),
    memory: () => size.memory?.(),
  });
  const failed = (err: unknown, code?: number): void =>
    transport.post({
      type: WASM_PROCESS_ERROR,
      message: err instanceof Error ? (rawStack(err) ?? err.message) : String(err),
      ...(code === undefined ? {} : { code }),
    } satisfies WasmProcessErrorMsg);
  transport.init.then(
    (init) => {
      const refused = refusal(init);
      if (refused) return failed(refused, NOT_RUNNABLE);
      started(init, transport, deps, size).then(
        (code) => transport.post({ type: WASM_PROCESS_EXIT, code } satisfies WasmProcessExitMsg),
        (err) => {
          if (!transport.closed) failed(err);
        }
      );
    },
    () => undefined
  );
}
