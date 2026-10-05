import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import { processEntry } from './process/process-entry.ts';

const scope = globalThis as { require?: unknown; __filename?: string; __dirname?: string };
scope.require ??= createRequire(import.meta.url);
scope.__filename ??= new URL(import.meta.url).pathname;
scope.__dirname ??= new URL('.', import.meta.url).pathname;

const port = parentPort as NonNullable<typeof parentPort>;
const onMessage = processEntry({ postMessage: (message: unknown) => port.postMessage(message) });
port.on('message', onMessage);
