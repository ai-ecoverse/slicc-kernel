import { openMeta } from './fs/meta.ts';
import { syncAccessHandles } from './fs/opfs.ts';
import type { WasmWorkerLike } from './kernel/host.ts';
import { openMedia } from './mount/media.ts';
import { pinScript } from './pin.ts';
import { type KernelPort, serveKernel } from './serve.ts';

const processWorker = pinScript(new URL('./process-worker.js', import.meta.url));
const driverWorker = pinScript(new URL('./driver-worker.js', import.meta.url));

serveKernel(globalThis as unknown as KernelPort, {
  storage: () => navigator.storage.getDirectory(),
  syncAccess: syncAccessHandles(),
  createWorker: () => new Worker(processWorker, { type: 'module' }) as WasmWorkerLike,
  createDriverWorker: () => new Worker(driverWorker, { type: 'module' }) as WasmWorkerLike,
  metadata: (name) => openMeta(name, indexedDB),
  media: (name) => openMedia(name, indexedDB),
});
