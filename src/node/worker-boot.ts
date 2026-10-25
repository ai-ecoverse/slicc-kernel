import { readFileSync } from 'node:fs';
import { MessageChannel, Worker, type WorkerOptions } from 'node:worker_threads';

export const PROCESS_BOOT = `(async () => {
  'use strict';
  const { workerData } = require('node:worker_threads');
  const { compileFunction, constants } = require('node:vm');
  const { createRequire } = require('node:module');
  const loader = constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
  const prime = () => {
    const emit = process.emitWarning;
    process.emitWarning = function (message, ...args) {
      if (message === 'vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time' && args[0] === 'ExperimentalWarning') return;
      return Reflect.apply(emit, this, [message, ...args]);
    };
    try {
      return compileFunction('return import("node:vm")', [], { importModuleDynamically: loader })();
    } finally {
      process.emitWarning = emit;
    }
  };
  const { runEntryPointWithESMLoader } = require('internal/modules/run_main');
  await runEntryPointWithESMLoader(async () => { await prime(); });
  const { source: bytes, cachedData, port } = workerData.boot;
  delete workerData.boot;
  const source = new TextDecoder().decode(bytes);
  const run = compileFunction(source, ['require', 'importMetaUrl'], {
    filename: 'slicc-kernel:/node-process-worker.js',
    importModuleDynamically: loader,
    cachedData,
    produceCachedData: cachedData === undefined,
  });
  port.postMessage({ cachedData: run.cachedData, rejected: run.cachedDataRejected === true });
  port.close();
  run(createRequire('/slicc-kernel/node-process-worker.js'), '/slicc-kernel/node-process-worker.js');
})();`;

export interface BootCache {
  source: Uint8Array;
  cachedData?: Uint8Array;
  attempts: number;
  rejected: number;
}

const bundles = new Map<string, BootCache>();

export function bootCache(file: URL, read = readFileSync): BootCache {
  let cache = bundles.get(file.href);
  if (!cache) {
    cache = {
      source: new TextEncoder().encode(read(file, 'utf8')),
      attempts: 0,
      rejected: 0,
    };
    bundles.set(file.href, cache);
  }
  return cache;
}

export function cachedBoot(
  cache: BootCache,
  data: { cachedData?: Uint8Array; rejected: boolean }
): void {
  if (data.rejected) cache.rejected++;
  if (data.cachedData) cache.cachedData = data.cachedData;
  else if (data.rejected) cache.cachedData = undefined;
}

export function bootWorker(
  file: string | URL,
  options: WorkerOptions,
  bundle: URL,
  make = (entry: string | URL, init: WorkerOptions) => new Worker(entry, init),
  read = readFileSync
): Worker {
  if (!(file instanceof URL) || file.href !== bundle.href) return make(file, options);
  const cache = bootCache(file, read);
  const { port1, port2 } = new MessageChannel();
  port1.once('message', (data) => {
    cachedBoot(cache, data);
    port1.close();
  });
  port1.unref();
  if (cache.cachedData) cache.attempts++;
  try {
    const worker = make(PROCESS_BOOT, {
      ...options,
      eval: true,
      workerData: {
        ...options.workerData,
        boot: { source: cache.source, cachedData: cache.cachedData, port: port2 },
      },
      transferList: [port2],
    });
    worker.once('exit', () => port1.close());
    return worker;
  } catch (err) {
    port1.close();
    port2.close();
    throw err;
  }
}
