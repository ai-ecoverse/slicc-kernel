import { isBuiltin, registerHooks } from 'node:module';
import { hide, lockdown, vacate } from './process/js/lockdown.ts';

export { vacate };

export const NODE_GLOBALS: readonly string[] = [
  'require',
  'module',
  'exports',
  '__filename',
  '__dirname',
  'localStorage',
  'sessionStorage',
];

export const NODE_SLOTS: readonly string[] = [
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

let locked = false;

const nodeProcess =
  typeof globalThis.process === 'object' && globalThis.process !== null
    ? globalThis.process
    : undefined;

export { nodeProcess };

export function nodeLockdown(scope: object = globalThis): void {
  if (locked) return;
  locked = true;
  zeroedBuffers(Buffer);
  lockdown(scope);
  hide(scope, NODE_GLOBALS);
  vacate(scope, NODE_SLOTS);
  refuseModules();
}
