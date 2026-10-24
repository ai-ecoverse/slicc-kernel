import { AsyncLocalStorage } from 'node:async_hooks';
import type { Session } from 'node:inspector';
import { isBuiltin, registerHooks } from 'node:module';
import { resolve, sep } from 'node:path';
import { types } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import { runInThisContext } from 'node:vm';
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

const BASE64_MODULE = 'data:text/javascript;base64,';
const fromBase64 = Buffer.from.bind(Buffer);
const toText = Function.prototype.call.bind(Buffer.prototype.toString) as (
  bytes: Buffer,
  encoding: 'utf8'
) => string;
const PLAIN_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function refuseModules(): void {
  registerHooks({
    resolve(specifier, context, next) {
      if (isBuiltin(specifier)) throw refused(specifier);
      const resolved = next(specifier, context);
      if (!resolved.url.startsWith('data:')) throw refused(resolved.url);
      return resolved;
    },
    load(url, context, next) {
      const payload = url.startsWith(BASE64_MODULE) ? url.slice(BASE64_MODULE.length) : '';
      const typed = Object.keys(context.importAttributes ?? {}).length > 0;
      if (typed || payload.length % 4 !== 0 || !PLAIN_BASE64.test(payload))
        return next(url, context);
      const source = toText(fromBase64(payload, 'base64'), 'utf8');
      return { format: 'module', source, shortCircuit: true };
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
  rss: number;
} {
  const heap = heapStatistics();
  const usage = memoryUsage();
  return {
    heapUsed: heap.used_heap_size,
    heapTotal: heap.total_heap_size,
    heapLimit: heap.heap_size_limit,
    external: heap.external_memory,
    arrayBuffers: usage.arrayBuffers,
    rss: usage.rss,
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

export function ownCache(dir: string, result: { directory?: string }): boolean {
  const active = result.directory;
  if (active === undefined) return false;
  if (!`${resolve(active)}${sep}`.startsWith(`${resolve(dir)}${sep}`)) {
    throw new Error(
      `slicc-kernel: compileCache ${dir} was asked for, but this worker already caches in ${active} (a host preload enabled it): refusing to run programs`
    );
  }
  return true;
}

const runHere = runInThisContext;

export function nodeRunScript(
  source: string,
  filename: string
): { value: unknown; completion: boolean } {
  const options = blank(null) as { filename: string };
  options.filename = filename;
  return freeze({ value: runHere(source, options), completion: true });
}

const isPromise = types.isPromise;
const here: object = globalThis;
const define = Reflect.defineProperty;
const remove = Reflect.deleteProperty;
const call = Reflect.apply;
const hasOwn = Object.hasOwn;
const stringify = JSON.stringify;
const endsWith = String.prototype.endsWith;
const sliceOf = String.prototype.slice;
const toHex = Number.prototype.toString;
const random = Math.random;
const makeBigInt = BigInt;
const builtin = process.getBuiltinModule.bind(process);
const find = Array.prototype.find;
const keysOf = Object.keys;
const nothing = Object.create;
const isList = Array.isArray;
const seal = Object.freeze;
const ownKeys = Reflect.ownKeys;
const ownDescriptor = Reflect.getOwnPropertyDescriptor;
const BASE = Object.prototype;
type Snapshot = ReadonlyArray<readonly [PropertyKey, PropertyDescriptor | undefined]>;

function snapshot(of: object): Snapshot {
  const keys = ownKeys(of);
  const out: Array<readonly [PropertyKey, PropertyDescriptor | undefined]> = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as PropertyKey;
    out[i] = [key, ownDescriptor(of, key)];
  }
  return out;
}

function sameDescriptor(
  a: PropertyDescriptor | undefined,
  b: PropertyDescriptor | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b;
  for (let i = 0; i < FIELDS.length; i++) {
    const field = FIELDS[i] as string;
    if (own(a, field) !== own(b, field)) return false;
  }
  return true;
}

const FIELDS = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
const BASE_SNAPSHOT = snapshot(BASE);

function baseUnchanged(): boolean {
  const keys = ownKeys(BASE);
  if (keys.length !== BASE_SNAPSHOT.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const was = BASE_SNAPSHOT[i] as readonly [PropertyKey, PropertyDescriptor | undefined];
    if (keys[i] !== was[0]) return false;
    if (!sameDescriptor(ownDescriptor(BASE, keys[i] as PropertyKey), was[1])) return false;
  }
  return true;
}
const SERIALIZED = [Array.prototype, String.prototype, Number.prototype, Boolean.prototype];

function untouched(): boolean {
  if (!baseUnchanged()) return false;
  for (let i = 0; i < SERIALIZED.length; i++) {
    if (ownDescriptor(SERIALIZED[i] as object, 'toJSON') !== undefined) return false;
  }
  return true;
}
const Failure = Error;
const WrongType = TypeError;

function own(from: unknown, key: string): unknown {
  return typeof from === 'object' && from !== null && hasOwn(from, key)
    ? (from as Record<string, unknown>)[key]
    : undefined;
}

function bare(fields: Record<string, unknown>): object {
  const out = nothing(null) as Record<string, unknown>;
  const keys = keysOf(fields);
  for (let i = 0; i < keys.length; i++) out[keys[i] as string] = fields[keys[i] as string];
  return out;
}

let session: Session | undefined;
let inspectorGone = false;
let probing = false;

function post(method: string, params: Record<string, unknown>): unknown {
  let out: unknown;
  let failed: unknown;
  let done = false;
  call((session as Session).post, session, [
    method,
    bare(params),
    (err: unknown, result: unknown) => {
      failed = err;
      out = result;
      done = true;
    },
  ]);
  if (!done) throw new Failure('slicc-kernel: the inspector did not answer synchronously');
  if (failed) throw failed;
  return out;
}

export function inspectorSession(load: () => { Session: new () => Session }): Session | undefined {
  try {
    const made = new (load().Session)();
    made.connect();
    return made;
  } catch {
    return undefined;
  }
}

function connected(): boolean {
  if (session) return true;
  if (inspectorGone) return false;
  session = inspectorSession(() => builtin('node:inspector') as { Session: new () => Session });
  inspectorGone = session === undefined;
  return !inspectorGone;
}

function idOf(key: string, value: unknown, group: string): unknown {
  if (!define(here, key, { __proto__: null, value, configurable: true } as PropertyDescriptor)) {
    return undefined;
  }
  const result = own(
    post('Runtime.evaluate', {
      expression: `this[${stringify(key)}]`,
      objectGroup: group,
      includeCommandLineAPI: false,
      silent: true,
      returnByValue: false,
      generatePreview: false,
    }),
    'result'
  );
  return own(result, 'objectId');
}

function primitive(remote: unknown): unknown {
  const raw = own(remote, 'unserializableValue');
  if (typeof raw !== 'string') return own(remote, 'value');
  if (call(endsWith, raw, ['n'])) return makeBigInt(call(sliceOf, raw, [0, -1]) as string);
  if (raw === 'NaN') return 0 / 0;
  if (raw === '-0') return -0;
  return raw === 'Infinity' ? 1 / 0 : -1 / 0;
}

function internal(list: unknown, name: string): unknown {
  if (!isList(list)) return undefined;
  return own(call(find, list, [(item: unknown) => own(item, 'name') === name]), 'value');
}

type Settled = { state: 'pending' | 'fulfilled' | 'rejected'; value: unknown };

function probe(promise: unknown, group: string, key: string): Settled | undefined {
  const promiseId = idOf(key, promise, group);
  if (promiseId === undefined) return undefined;
  const found = own(
    post('Runtime.getProperties', {
      objectId: promiseId,
      ownProperties: true,
      generatePreview: false,
    }),
    'internalProperties'
  );
  const state = own(internal(found, '[[PromiseState]]'), 'value') as Settled['state'];
  if (state === 'pending') return seal({ state, value: undefined });
  const result = internal(found, '[[PromiseResult]]');
  const resultId = own(result, 'objectId');
  if (typeof resultId !== 'string') return seal({ state, value: primitive(result) });
  const holder = nothing(null) as { v?: unknown };
  const holderId = idOf(key, holder, group);
  post('Runtime.callFunctionOn', {
    objectId: resultId,
    functionDeclaration: 'function (h) { "use strict"; h.v = this; }',
    arguments: [bare({ objectId: holderId })],
    objectGroup: group,
    silent: true,
    returnByValue: false,
    generatePreview: false,
  });
  return seal({ state, value: holder.v });
}

export function nodePromiseState(promise: unknown): Settled | undefined {
  if (!isPromise(promise)) throw new WrongType('promiseState needs a native promise');
  if (probing) throw new Failure('slicc-kernel: promiseState is already running');
  if (!untouched() || !connected()) return undefined;
  probing = true;
  const tag = call(toHex, random() * 2 ** 52, [16]) as string;
  const group = `slicc-promise-${tag}`;
  const key = `__slicc_promise_${tag}`;
  try {
    return probe(promise, group, key);
  } finally {
    remove(here, key);
    try {
      post('Runtime.releaseObjectGroup', { objectGroup: group });
    } finally {
      probing = false;
    }
  }
}

const Storage = AsyncLocalStorage;
const apply = Reflect.apply;
const freeze = Object.freeze;
const blank = Object.create;

export function nodeAsyncContext(): {
  run<R>(store: unknown, fn: (...args: unknown[]) => R, ...args: unknown[]): R;
  getStore(): unknown;
  enterWith(store: unknown): void;
} {
  const storage = new Storage<unknown>();
  const run = storage.run.bind(storage);
  const getStore = storage.getStore.bind(storage);
  const enterWith = storage.enterWith.bind(storage);
  const api = blank(null);
  api.run = freeze(<R>(store: unknown, fn: (...args: unknown[]) => R, ...args: unknown[]): R => {
    if (typeof fn !== 'function') throw new TypeError('asyncContext.run needs a function');
    return run(store, () => apply(fn, undefined, args));
  });
  api.getStore = freeze((): unknown => getStore());
  api.enterWith = freeze((store: unknown): void => enterWith(store));
  return freeze(api);
}
