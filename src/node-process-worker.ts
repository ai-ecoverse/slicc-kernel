import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import { nodeLockdown } from './node-lockdown.ts';
import { runJsProcess } from './process/js/js-runtime.ts';
import { processEntry } from './process/process-entry.ts';

const scope = globalThis as { require?: unknown; __filename?: string; __dirname?: string };
scope.require ??= createRequire(import.meta.url);
scope.__filename ??= new URL(import.meta.url).pathname;
scope.__dirname ??= new URL('.', import.meta.url).pathname;

const port = parentPort as NonNullable<typeof parentPort>;
const post = { postMessage: (message: unknown) => port.postMessage(message) };
const onMessage = processEntry(post, undefined, undefined, async () => ({
  runJsProcess: (init, at) => runJsProcess(init, at, { lockdown: () => nodeLockdown() }),
}));
port.on('message', onMessage);
