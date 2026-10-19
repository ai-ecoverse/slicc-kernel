import { lockdown } from './process/js/lockdown.ts';
import { processEntry } from './process/process-entry.ts';
import { pinRootKind } from './process/process-fds.ts';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const post = scope.postMessage.bind(scope);
const onMessage = processEntry(
  { postMessage: (message, transfer) => post(message, transfer ?? []) },
  undefined,
  undefined,
  undefined,
  () => {
    pinRootKind();
    lockdown();
  }
);
scope.addEventListener('message', (event) => onMessage(event.data));
