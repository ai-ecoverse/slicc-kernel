import { isBuiltin, registerHooks } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { hide, lockdown, vacate } from './process/js/lockdown.ts';

export { vacate };

export const NODE_GLOBALS: readonly string[] = ['localStorage', 'sessionStorage'];

export const NODE_SLOTS: readonly string[] = [
  'require',
  'module',
  'exports',
  '__filename',
  '__dirname',
  'process',
  'global',
  'setImmediate',
  'clearImmediate',
];

export function zeroedBuffers(buffer: typeof Buffer): void {
  const alloc = buffer.alloc.bind(buffer);
  const fixed = (value: unknown) => ({ value, writable: false, configurable: false });
  Object.defineProperties(buffer, {
    allocUnsafe: fixed((size: number) => alloc(size)),
    allocUnsafeSlow: fixed((size: number) => alloc(size)),
    poolSize: fixed(0),
  });
}

function refused(specifier: string): Error {
  return Object.assign(new Error(`slicc-kernel: a JS program cannot import ${specifier}`), {
    code: 'ERR_ACCESS_DENIED',
  });
}

export function refuseModules(): void {
  registerHooks({
    resolve(specifier, context, next) {
      if (isBuiltin(specifier)) throw refused(specifier);
      const resolved = next(specifier, context);
      if (!resolved.url.startsWith('data:')) throw refused(resolved.url);
      return resolved;
    },
  });
}

const locked = new WeakSet<object>();

const nodeProcess =
  typeof globalThis.process === 'object' && globalThis.process !== null
    ? globalThis.process
    : undefined;

export { nodeProcess };

const heapStatistics = getHeapStatistics;
const memoryUsage = process.memoryUsage.bind(process);

export function nodeMemory(): {
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
  external: number;
  arrayBuffers: number;
} {
  const heap = heapStatistics();
  const usage = memoryUsage();
  return {
    heapUsed: heap.used_heap_size,
    heapTotal: heap.total_heap_size,
    heapLimit: heap.heap_size_limit,
    external: heap.external_memory,
    arrayBuffers: usage.arrayBuffers,
  };
}

export function nodeLockdown(scope: object = globalThis): void {
  if (locked.has(scope)) return;
  locked.add(scope);
  zeroedBuffers(Buffer);
  lockdown(scope);
  hide(scope, NODE_GLOBALS);
  vacate(scope, NODE_SLOTS);
  refuseModules();
}

class WorkerGlobalScope {}

export function glueUrl(path: string | undefined): string {
  const at = path?.startsWith('/') ? path : '/';
  return `file://${at.split('/').map(encodeURIComponent).join('/')}`;
}

export function workerShaped(scope: object, href: string): void {
  const slot = (value: unknown) => ({
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperties(scope, {
    WorkerGlobalScope: slot(WorkerGlobalScope),
    self: slot(scope),
    location: slot(Object.freeze({ href })),
  });
}
