import { processEntry } from './process/process-entry.ts';

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const post = scope.postMessage.bind(scope);
const onMessage = processEntry({ postMessage: (message) => post(message) });
scope.addEventListener('message', (event) => onMessage(event.data));
