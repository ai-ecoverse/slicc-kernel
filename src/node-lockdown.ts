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
  buffer.allocUnsafe = (size: number) => alloc(size);
  buffer.allocUnsafeSlow = (size: number) => alloc(size);
  buffer.poolSize = 0;
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

export function nodeLockdown(scope: object = globalThis): void {
  zeroedBuffers(Buffer);
  lockdown(scope);
  hide(scope, NODE_GLOBALS);
  vacate(scope, NODE_SLOTS);
  refuseModules();
}
