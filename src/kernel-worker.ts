import type { WasmWorkerLike } from './kernel/host.ts';
import { type KernelPort, serveKernel } from './serve.ts';

const processWorker = new URL('./process-worker.js', import.meta.url);

serveKernel(globalThis as unknown as KernelPort, {
  storage: () => navigator.storage.getDirectory(),
  createWorker: () => new Worker(processWorker, { type: 'module' }) as WasmWorkerLike,
});
