import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  type WasmProcessErrorMsg,
  type WasmProcessExitMsg,
  type WasmProcessInitMsg,
} from '../kernel/protocol.ts';
import type { SabPostLike } from '../realm/sync-sab-bridge.ts';
import { runWasmProcess } from './process-runtime.ts';

export type ProcessRunner = (init: WasmProcessInitMsg, port: SabPostLike) => Promise<number>;

export function processEntry(
  port: SabPostLike,
  run: ProcessRunner = runWasmProcess
): (data: unknown) => void {
  return (data) => {
    if ((data as { type?: string } | undefined)?.type !== WASM_PROCESS_INIT) return;
    run(data as WasmProcessInitMsg, port).then(
      (code) => port.postMessage({ type: WASM_PROCESS_EXIT, code } satisfies WasmProcessExitMsg),
      (err) =>
        port.postMessage({
          type: WASM_PROCESS_ERROR,
          message: err instanceof Error ? (err.stack ?? err.message) : String(err),
        } satisfies WasmProcessErrorMsg)
    );
  };
}
