type WaitResult = 'ok' | 'not-equal' | 'timed-out';

export type AsyncWaiter = (
  typed: Int32Array,
  index: number,
  value: number,
  timeout?: number
) => Promise<WaitResult>;

interface Jspi {
  Suspending: new (fn: (...args: never[]) => unknown) => object;
  promising<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => Promise<R>;
}

const jspi = WebAssembly as unknown as Partial<Jspi>;

export function jspiAvailable(): boolean {
  return typeof jspi.Suspending === 'function' && typeof jspi.promising === 'function';
}

const AsyncFunction = (async () => {}).constructor;

const waiters = new WeakMap<ArrayBufferLike, AsyncWaiter>();

export function registerWaiter(buffer: ArrayBufferLike, waiter: AsyncWaiter): void {
  waiters.set(buffer, waiter);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function atomicsWait(
  typed: Int32Array,
  index: number,
  value: number,
  timeout?: number
): Promise<WaitResult> {
  const waiter = waiters.get(typed.buffer);
  if (waiter) return waiter(typed, index, value, timeout);
  if (Atomics.load(typed, index) !== value) return 'not-equal';
  const ms = timeout ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(ms)) {
    throw new Error('async process: a blocking wait that nothing can wake (no threads here)');
  }
  await sleep(Math.max(0, ms));
  return Atomics.load(typed, index) !== value ? 'ok' : 'timed-out';
}

export function suspendingImports(imports: WebAssembly.Imports): WebAssembly.Imports {
  const Suspending = jspi.Suspending;
  if (!Suspending) throw new Error('async process: this engine has no WebAssembly.Suspending');
  const out: WebAssembly.Imports = {};
  for (const [ns, table] of Object.entries(imports)) {
    const wrapped: WebAssembly.ModuleImports = {};
    for (const [name, value] of Object.entries(table)) {
      wrapped[name] =
        value instanceof AsyncFunction
          ? (new Suspending(value as (...args: never[]) => unknown) as WebAssembly.ImportValue)
          : value;
    }
    out[ns] = wrapped;
  }
  return out;
}

const entries = new WeakMap<object, unknown>();

export function reentered<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => Promise<R> {
  const known = entries.get(fn) as ((...args: A) => Promise<R>) | undefined;
  if (known) return known;
  const promising = jspi.promising;
  if (!promising) throw new Error('async process: this engine has no WebAssembly.promising');
  let entry: (...args: A) => Promise<R>;
  try {
    entry = promising(fn);
  } catch {
    entry = async (...args: A) => fn(...args);
  }
  entries.set(fn, entry);
  return entry;
}

export function refusedModule(_bytes?: unknown): WebAssembly.Module {
  throw new Error('compiling wasm at run time is not supported by the async process host');
}

export function refusedImport(_specifier?: unknown): Promise<never> {
  return Promise.reject(
    new Error('loading JavaScript at run time is not supported by the async process host')
  );
}
