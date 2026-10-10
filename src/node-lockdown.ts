import { isBuiltin, registerHooks } from 'node:module';
import { hide, lockdown } from './process/js/lockdown.ts';

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
  'Buffer',
  'global',
  'setImmediate',
  'clearImmediate',
];

export function vacate(target: object, names: readonly string[]): void {
  for (const name of names) {
    for (let at: object | null = target; at && at !== Object.prototype; ) {
      if (Object.getOwnPropertyDescriptor(at, name)?.configurable) Reflect.deleteProperty(at, name);
      at = Object.getPrototypeOf(at);
    }
    Reflect.defineProperty(target, name, {
      value: undefined,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    if (Reflect.get(target, name) !== undefined) {
      throw new Error(`slicc-kernel: cannot withhold ${name} from a JS program`);
    }
  }
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
  lockdown(scope);
  hide(scope, NODE_GLOBALS);
  vacate(scope, NODE_SLOTS);
  refuseModules();
}
