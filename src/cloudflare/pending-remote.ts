import type { WasmWorkerLike } from '../kernel/host.ts';
import type { Processes } from './loader.ts';

const MISSING = 'the remote process worker is not built into this kernel yet';

export function pendingRemoteWorker(_open: Processes['open']): WasmWorkerLike {
  const errors = new Set<(event: MessageEvent) => void>();
  setTimeout(() => {
    for (const handler of errors)
      handler({ message: MISSING, preventDefault() {} } as unknown as MessageEvent);
  }, 0);
  return {
    postMessage() {},
    addEventListener(type, handler) {
      if (type === 'error') errors.add(handler);
    },
    removeEventListener(_type, handler) {
      errors.delete(handler);
    },
    terminate() {},
  };
}
