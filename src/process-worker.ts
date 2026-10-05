import { processEntry } from './process/process-entry.ts';

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const onMessage = processEntry({ postMessage: (message) => scope.postMessage(message) });
scope.addEventListener('message', (event) => onMessage(event.data));
