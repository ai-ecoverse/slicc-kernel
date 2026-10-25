import { createRequire, enableCompileCache, flushCompileCache } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import {
  glueUrl,
  moduleSource,
  nodeAsyncContext,
  nodeLockdown,
  nodeMemory,
  nodeProcess,
  nodePromiseState,
  nodeRunScript,
  ownCache,
  workerShaped,
} from './node-lockdown.ts';
import { nodeErrorSource, nodeStackFormatter } from './node-stack.ts';
import { runJsProcess, runJsThread } from './process/js/js-runtime.ts';
import { processEntry } from './process/process-entry.ts';
import { runWasmProcess } from './process/process-runtime.ts';
import * as wasiRuntime from './process/wasi/wasi-runtime.ts';

const scope = globalThis as { require?: unknown; __filename?: string; __dirname?: string };
scope.require ??= createRequire(import.meta.url);
scope.__filename ??= new URL(import.meta.url).pathname;
scope.__dirname ??= new URL('.', import.meta.url).pathname;

const data = workerData as { compileCache?: unknown; ownedCache?: unknown } | null;
const cacheDir = data?.compileCache;
const cached =
  typeof cacheDir === 'string' &&
  ownCache(cacheDir, enableCompileCache(cacheDir), data?.ownedCache === true);
const imported = cached ? () => flushCompileCache() : undefined;

const port = parentPort as NonNullable<typeof parentPort>;
const post = {
  postMessage: (message: unknown, transfer?: Transferable[]) =>
    port.postMessage(message, transfer as never),
};
const strayScope = nodeProcess ? { process: nodeProcess } : {};
const onMessage = processEntry(
  post,
  (init, at) => {
    workerShaped(globalThis, glueUrl(init.program?.path));
    return runWasmProcess(init, at);
  },
  async () => wasiRuntime,
  async () => ({
    runJsProcess: (init, at) =>
      runJsProcess(init, at, {
        lockdown: () => nodeLockdown(),
        scope: strayScope,
        memory: nodeMemory,
        asyncContext: nodeAsyncContext,
        runScript: nodeRunScript,
        moduleSource,
        promiseState: nodePromiseState,
        stackFormatter: nodeStackFormatter,
        errorSource: nodeErrorSource,
        imported,
      }),
    runJsThread: (init, at) =>
      runJsThread(init, at, {
        lockdown: () => nodeLockdown(),
        scope: strayScope,
        memory: nodeMemory,
        asyncContext: nodeAsyncContext,
        runScript: nodeRunScript,
        moduleSource,
        promiseState: nodePromiseState,
        stackFormatter: nodeStackFormatter,
        errorSource: nodeErrorSource,
        imported,
      }),
  }),
  () => nodeLockdown()
);
port.on('message', onMessage);
