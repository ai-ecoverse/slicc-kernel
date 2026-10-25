import { useLocalClock } from '../kernel/cpu-clock.ts';
import {
  JS_THREAD_EXIT,
  JS_THREAD_INIT,
  type JsProcessInitMsg,
  type JsThreadExitMsg,
  type JsThreadInitMsg,
  type ProcessInitMsg,
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  WASM_THREAD_INIT,
  type WasmProcessErrorMsg,
  type WasmProcessExitMsg,
  type WasmProcessInitMsg,
  type WasmThreadInitMsg,
} from '../kernel/protocol.ts';
import type { SabPostLike } from '../realm/sync-sab-bridge.ts';
import { runWasmProcess } from './process-runtime.ts';
import { rawStack } from './raw-stack.ts';

export type ProcessRunner = (init: WasmProcessInitMsg, port: SabPostLike) => Promise<number>;

export interface WasiRuntime {
  runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number>;
  runWasiThread(init: WasmThreadInitMsg, port: SabPostLike): Promise<void>;
}

export type WasiLoader = () => Promise<WasiRuntime>;

export interface JsRuntime {
  runJsProcess(init: JsProcessInitMsg, port: SabPostLike): Promise<number>;
  runJsThread?(init: JsThreadInitMsg, port: SabPostLike): Promise<number>;
}

export type JsLoader = () => Promise<JsRuntime>;

const loadWasi: WasiLoader = () => import('./wasi/wasi-runtime.ts');

const loadJs: JsLoader = () => import('./js/js-runtime.ts');

const NOT_RUNNABLE = 126;

function started(
  init: ProcessInitMsg,
  port: SabPostLike,
  run: ProcessRunner,
  wasi: WasiLoader,
  js: JsLoader
): Promise<number> {
  if (init.program?.abi === 'js') {
    const jsInit = init as JsProcessInitMsg;
    return js().then((m) => m.runJsProcess(jsInit, port));
  }
  const wasmInit = init as WasmProcessInitMsg;
  if (wasmInit.program?.abi === 'wasi') return wasi().then((m) => m.runWasiProcess(wasmInit, port));
  return run(wasmInit, port);
}

export function processEntry(
  port: SabPostLike,
  run: ProcessRunner = runWasmProcess,
  wasi: WasiLoader = loadWasi,
  js: JsLoader = loadJs,
  seal: () => void = () => {}
): (data: unknown) => void {
  const failed = (err: unknown, code?: number): void =>
    port.postMessage({
      type: WASM_PROCESS_ERROR,
      message: err instanceof Error ? (rawStack(err) ?? err.message) : String(err),
      ...(code === undefined ? {} : { code }),
    } satisfies WasmProcessErrorMsg);
  let refused: { error: unknown } | null | undefined;
  const sealOnce = (): { error: unknown } | null => {
    if (refused === undefined) {
      try {
        seal();
        refused = null;
      } catch (error) {
        refused = { error };
      }
    }
    return refused;
  };
  return (data) => {
    const type = (data as { type?: string } | undefined)?.type;
    if (type !== WASM_THREAD_INIT && type !== WASM_PROCESS_INIT && type !== JS_THREAD_INIT) return;
    const refusal = sealOnce();
    if (type === JS_THREAD_INIT) {
      if (refusal) return failed(refusal.error);
      js()
        .then((m) => {
          if (!m.runJsThread) throw new Error('this process worker runs no JS threads');
          return m.runJsThread(data as JsThreadInitMsg, port);
        })
        .then(
          (code) => port.postMessage({ type: JS_THREAD_EXIT, code } satisfies JsThreadExitMsg),
          failed
        );
      return;
    }
    const init = data as { sab?: SharedArrayBuffer; program?: { abi?: string } } | undefined;
    if (type === WASM_THREAD_INIT || init?.program?.abi !== 'js') useLocalClock(init?.sab);
    if (type === WASM_THREAD_INIT) {
      if (refusal) return failed(refusal.error);
      wasi()
        .then((m) => m.runWasiThread(data as WasmThreadInitMsg, port))
        .catch(failed);
      return;
    }
    if (refusal) return failed(refusal.error, NOT_RUNNABLE);
    started(data as ProcessInitMsg, port, run, wasi, js).then(
      (code) => port.postMessage({ type: WASM_PROCESS_EXIT, code } satisfies WasmProcessExitMsg),
      failed
    );
  };
}
