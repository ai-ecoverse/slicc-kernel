import {
  type JsProcessInitMsg,
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

export type ProcessRunner = (init: WasmProcessInitMsg, port: SabPostLike) => Promise<number>;

export interface WasiRuntime {
  runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number>;
  runWasiThread(init: WasmThreadInitMsg, port: SabPostLike): Promise<void>;
}

export type WasiLoader = () => Promise<WasiRuntime>;

export interface JsRuntime {
  runJsProcess(init: JsProcessInitMsg, port: SabPostLike): Promise<number>;
}

export type JsLoader = () => Promise<JsRuntime>;

const loadWasi: WasiLoader = () => import('./wasi/wasi-runtime.ts');

const loadJs: JsLoader = () => import('./js/js-runtime.ts');

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
  js: JsLoader = loadJs
): (data: unknown) => void {
  const failed = (err: unknown): void =>
    port.postMessage({
      type: WASM_PROCESS_ERROR,
      message: err instanceof Error ? (err.stack ?? err.message) : String(err),
    } satisfies WasmProcessErrorMsg);
  return (data) => {
    const type = (data as { type?: string } | undefined)?.type;
    if (type === WASM_THREAD_INIT) {
      wasi()
        .then((m) => m.runWasiThread(data as WasmThreadInitMsg, port))
        .catch(failed);
      return;
    }
    if (type !== WASM_PROCESS_INIT) return;
    started(data as ProcessInitMsg, port, run, wasi, js).then(
      (code) => port.postMessage({ type: WASM_PROCESS_EXIT, code } satisfies WasmProcessExitMsg),
      failed
    );
  };
}
