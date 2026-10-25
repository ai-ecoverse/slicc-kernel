import { createRequire } from 'node:module';
import { types } from 'node:util';
import type { JsErrorSource, JsStackFormatter } from './process/js/js-context.ts';
import { setRawStack } from './process/raw-stack.ts';

type Prepare = (error: unknown, trace: object[]) => unknown;

type Callback = (realm: unknown, error: unknown, trace: object[]) => unknown;

interface Positions {
  sourceLine?: unknown;
  scriptResourceName?: unknown;
  lineNumber?: unknown;
  startColumn?: unknown;
}

interface Internals {
  setInternalPrepareStackTrace: (fn: Prepare) => void;
  fallback: Prepare;
  positions: ((error: object) => Positions | undefined) | undefined;
  setCallback: ((fn: Callback) => void) | undefined;
  overrides: WeakMap<object, Prepare>;
  nodeDefault: unknown;
}

interface ErrorsBinding {
  getErrorSourcePositions?: unknown;
  setPrepareStackTraceCallback?: unknown;
}

type Binding = (name: string) => ErrorsBinding;

export function quietly<T>(target: { emitWarning: unknown }, run: () => T): T {
  const emit = target.emitWarning;
  target.emitWarning = () => {};
  try {
    return run();
  } finally {
    target.emitWarning = emit;
  }
}

export function bindingOf(load: (id: string) => unknown): ErrorsBinding {
  try {
    const { internalBinding } = quietly(
      process,
      () => load('internal/test/binding') as { internalBinding: Binding }
    );
    return internalBinding('errors');
  } catch {
    return {};
  }
}

function fn<T>(value: unknown): T | undefined {
  return typeof value === 'function' ? (value as T) : undefined;
}

const apply = Reflect.apply;
const push = Array.prototype.push;
const startsWith = String.prototype.startsWith;
const slice = String.prototype.slice;
const lastIndexOf = String.prototype.lastIndexOf;
const indexOf = String.prototype.indexOf;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const mapGet = WeakMap.prototype.get;
const mapSet = WeakMap.prototype.set;
const mapHas = WeakMap.prototype.has;
const mapDelete = WeakMap.prototype.delete;
const MainError = Error;
const isNativeError = types.isNativeError;
const freeze = Object.freeze;
const blank = Object.create;

function internals(): Internals | undefined {
  try {
    const load = createRequire(import.meta.url);
    const errors = load('internal/errors') as {
      setInternalPrepareStackTrace?: unknown;
      defaultPrepareStackTrace?: unknown;
      overrideStackTrace?: unknown;
      ErrorPrepareStackTrace?: unknown;
    };
    const set = errors.setInternalPrepareStackTrace;
    let fallback = errors.defaultPrepareStackTrace;
    if (process.sourceMapsEnabled) {
      fallback = (
        load('internal/source_map/prepare_stack_trace') as {
          prepareStackTraceWithSourceMaps?: unknown;
        }
      ).prepareStackTraceWithSourceMaps;
    }
    const overrides = errors.overrideStackTrace;
    const usable = typeof set === 'function' && typeof fallback === 'function';
    if (!usable || !types.isWeakMap(overrides)) return undefined;
    const binding = bindingOf(load);
    return {
      setInternalPrepareStackTrace: set as Internals['setInternalPrepareStackTrace'],
      fallback: fallback as Prepare,
      positions: fn(binding.getErrorSourcePositions),
      setCallback: fn(binding.setPrepareStackTraceCallback),
      overrides: overrides as WeakMap<object, Prepare>,
      nodeDefault: errors.ErrorPrepareStackTrace,
    };
  } catch {
    return undefined;
  }
}

interface Site {
  getFileName(): string | null | undefined;
  getScriptHash(): string;
  isEval(): boolean;
  getEvalOrigin(): string | undefined;
  getLineNumber(): number | null;
  getScriptNameOrSourceURL(): string | null | undefined;
  getFunctionName(): string | null;
  getTypeName(): string | null;
}

function ownSite(): Site {
  const saved = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  try {
    Object.defineProperty(Error, 'prepareStackTrace', {
      value: (_: unknown, sites: object[]) => sites[0],
      configurable: true,
      writable: true,
    });
    return (new Error() as unknown as { stack: Site }).stack;
  } finally {
    delete (Error as { prepareStackTrace?: unknown }).prepareStackTrace;
    Object.defineProperties(Error, saved ? { prepareStackTrace: saved } : {});
  }
}

const self = ownSite();
const proto = Object.getPrototypeOf(self) as Site;
const fileOf = proto.getFileName;
const hashOf = proto.getScriptHash;
const isEval = proto.isEval;
const originOf = proto.getEvalOrigin;
const lineOf = proto.getLineNumber;
const nameOf = proto.getScriptNameOrSourceURL;
const functionOf = proto.getFunctionName;
const typeOf = proto.getTypeName;
const syntaxProto = SyntaxError.prototype;
const protoOf = Object.getPrototypeOf;
const ownNames = new Set<unknown>([
  apply(fileOf, self, []),
  apply(proto.getScriptNameOrSourceURL, self, []),
]);
const ownHash = apply(hashOf, self, []) as string;

const programHashes = new Set<string>();
const programNames = new Set<string>();

export function programScript(name: string, hash: string): void {
  apply(setAdd, programNames, [name]);
  apply(setAdd, programHashes, [hash]);
}

const SOURCE_NAMES = 4096;
const sourceNames = new Set<string>();
const setDelete = Set.prototype.delete;
const setValues = Set.prototype.values;
const sizeOf = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get as (
  this: Set<string>
) => number;
const nextOf = Object.getPrototypeOf(new Set().values()).next as (
  this: Iterator<string>
) => IteratorResult<string>;

function noteName(name: string): void {
  if (
    apply(setDelete, sourceNames, [name]) !== true &&
    apply(sizeOf, sourceNames, []) >= SOURCE_NAMES
  ) {
    const oldest = apply(nextOf, apply(setValues, sourceNames, []), []) as IteratorResult<string>;
    apply(setDelete, sourceNames, [oldest.value]);
  }
  apply(setAdd, sourceNames, [name]);
}

function programName(name: string): boolean {
  return (
    apply(startsWith, name, ['data:']) === true ||
    apply(setHas, programNames, [name]) === true ||
    apply(setHas, sourceNames, [name]) === true
  );
}

export function noteSourceUrls(trace: readonly object[]): void {
  for (let i = 0; i < trace.length; i++) {
    const site = trace[i] as object;
    if (apply(isEval, site, []) !== true || apply(hashOf, site, []) === ownHash) continue;
    const origin = apply(originOf, site, []) as string | undefined;
    if (typeof origin !== 'string' || evalAt(origin)) continue;
    const name = apply(nameOf, site, []) as unknown;
    if (typeof name !== 'string' || apply(setHas, ownNames, [name]) === true) continue;
    noteName(name);
  }
}

export function rootOrigin(origin: string): string {
  let at = origin;
  while (apply(startsWith, at, ['eval at ']) === true) {
    const open = apply(indexOf, at, [' (']) as number;
    if (open < 0) return '';
    let depth = 1;
    let i = open + 2;
    for (; i < at.length && depth > 0; i++) {
      const c = at[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    if (depth !== 0) return '';
    at = apply(slice, at, [open + 2, i - 1]) as string;
  }
  let end = at.length;
  for (let n = 0; n < 2; n++) {
    const colon = apply(lastIndexOf, at, [':', end - 1]) as number;
    if (colon <= 0) break;
    end = colon;
  }
  return apply(slice, at, [0, end]) as string;
}

function evalAt(origin: string): boolean {
  return apply(startsWith, origin, ['eval at ']) === true;
}

function scriptOf(site: object): unknown {
  if (apply(isEval, site, []) !== true) return apply(fileOf, site, []);
  const origin = apply(originOf, site, []) as string | undefined;
  if (typeof origin !== 'string' || evalAt(origin)) return undefined;
  return apply(nameOf, site, []);
}

export function keptFrame(site: object): boolean {
  const hash = apply(hashOf, site, []) as string;
  if (hash === ownHash) return false;
  if (apply(isEval, site, []) === true) {
    const origin = apply(originOf, site, []) as string | undefined;
    if (typeof origin !== 'string') return false;
    return !evalAt(origin) || programName(rootOrigin(origin));
  }
  const file = apply(fileOf, site, []) as unknown;
  if (typeof file !== 'string') return true;
  if (apply(setHas, programHashes, [hash]) === true) return true;
  return apply(startsWith, file, ['node:']) === true || programName(file);
}

export function keptFrames(trace: readonly object[]): object[] {
  noteSourceUrls(trace);
  const out: object[] = [];
  for (let i = 0; i < trace.length; i++) {
    const site = trace[i] as object;
    if (keptFrame(site)) apply(push, out, [site]);
  }
  return out;
}

let formatter: JsStackFormatter | null = null;
let withOwn = false;
let formatting = false;

interface Seen {
  site: object;
  next: object | undefined;
  at: Positions | undefined;
}

const seen = new WeakMap<object, Seen>();

function positionsAt(
  positions: Internals['positions'],
  error: object,
  site: object
): Positions | undefined {
  if (positions === undefined || !keptFrame(site)) return undefined;
  try {
    return positions(error);
  } catch {
    return undefined;
  }
}

function record(positions: Internals['positions'], error: unknown, trace: object[]): void {
  if (trace.length > 0 && isNativeError(error)) {
    noteSourceUrls(trace);
    const site = trace[0] as object;
    const next = trace[1] as object | undefined;
    apply(mapSet, seen, [error, { site, next, at: positionsAt(positions, error, site) }]);
  }
}

export function stackDispatcher(fallback: Prepare, positions?: Internals['positions']): Prepare {
  return (error, trace) => {
    record(positions, error, trace);
    const fn = formatter;
    if (fn === null || formatting) return apply(fallback, undefined, [error, trace]);
    formatting = true;
    try {
      const out = apply(fn, undefined, [error, keptFrames(trace)]);
      if (typeof out === 'string') return out;
    } catch {
    } finally {
      formatting = false;
    }
    return apply(fallback, undefined, [error, trace]);
  };
}

interface Own {
  fn: Prepare;
  self: unknown;
}

function errorOf(realm: unknown): unknown {
  return realm === null || realm === undefined ? undefined : (realm as { Error?: unknown }).Error;
}

function prepareOf(holder: unknown): unknown {
  return holder === null || holder === undefined
    ? undefined
    : (holder as { prepareStackTrace?: unknown }).prepareStackTrace;
}

export function ownPrepare(realm: unknown, nodeDefault: unknown): Own | undefined {
  let self: unknown;
  if (typeof prepareOf(errorOf(realm)) === 'function') self = errorOf(realm);
  else if (typeof prepareOf(MainError) === 'function') self = MainError;
  else return undefined;
  const value = prepareOf(self);
  return value === nodeDefault ? undefined : { fn: value as Prepare, self };
}

function calling<T>(run: () => T): T {
  formatting = true;
  try {
    return run();
  } finally {
    formatting = false;
  }
}

export function kernelCallback(
  internal: Pick<Internals, 'fallback' | 'positions' | 'overrides' | 'nodeDefault'>,
  dispatch: Prepare
): Callback {
  const { fallback, positions, overrides, nodeDefault } = internal;
  return (realm, error, trace) => {
    if (apply(mapHas, overrides, [error]) === true) {
      const override = apply(mapGet, overrides, [error]) as Prepare;
      apply(mapDelete, overrides, [error]);
      return apply(override, undefined, [error, trace]);
    }
    const own = ownPrepare(realm, nodeDefault);
    if (formatting) return apply(fallback, undefined, [error, keptFrames(trace)]);
    const fmt = formatter;
    if (fmt !== null && withOwn) {
      record(positions, error, trace);
      return calling(() => apply(fmt, undefined, [error, keptFrames(trace), own?.fn]));
    }
    if (own === undefined) return apply(dispatch, undefined, [error, trace]);
    record(positions, error, trace);
    return apply(own.fn, own.self, [error, trace]);
  };
}

export function rawReader(
  overrides: WeakMap<object, Prepare>,
  fallback: Prepare
): (error: Error) => unknown {
  return (error) => {
    apply(mapSet, overrides, [
      error,
      (e: unknown, trace: object[]) => apply(fallback, undefined, [e, trace]),
    ]);
    try {
      return error.stack;
    } finally {
      apply(mapDelete, overrides, [error]);
    }
  };
}

const found = internals();
if (found) {
  const dispatch = stackDispatcher(found.fallback, found.positions);
  found.setInternalPrepareStackTrace(dispatch);
  if (found.setCallback) {
    found.setCallback(kernelCallback(found, dispatch));
    setRawStack(rawReader(found.overrides, found.fallback));
  }
}

export const nodeStackFormatter:
  | ((fn: JsStackFormatter | null, options?: { own?: boolean }) => JsStackFormatter | null)
  | undefined = found
  ? (next, options) => {
      if (next !== null && typeof next !== 'function') {
        throw new TypeError('setStackFormatter needs a function or null');
      }
      const own = options === undefined ? false : (options as { own?: unknown }).own;
      if (typeof own !== 'boolean' && own !== undefined) {
        throw new TypeError('setStackFormatter: own must be a boolean');
      }
      const previous = formatter;
      formatter = next;
      withOwn = next !== null && own === true;
      return previous;
    }
  : undefined;

function programFrame(site: object | undefined): boolean {
  if (site === undefined || !keptFrame(site)) return false;
  if (apply(isEval, site, []) === true) return true;
  const file = apply(fileOf, site, []) as unknown;
  return typeof file === 'string' && apply(startsWith, file, ['node:']) !== true;
}

export function jsonParseSite(error: object, got: Seen): boolean {
  const { site, next } = got;
  if (protoOf(error) !== syntaxProto || apply(fileOf, site, []) !== null) return false;
  if (apply(functionOf, site, []) !== 'parse' || apply(typeOf, site, []) !== 'JSON') return false;
  return programFrame(next);
}

export function errorSourceOf(error: unknown): JsErrorSource | undefined {
  if (typeof error !== 'object' || error === null || !isNativeError(error)) return undefined;
  try {
    void (error as { stack?: unknown }).stack;
  } catch {
    return undefined;
  }
  const got = apply(mapGet, seen, [error]) as Seen | undefined;
  if (got === undefined || !keptFrame(got.site)) return undefined;
  const { site, at } = got;
  if (!at || typeof at.sourceLine !== 'string' || typeof at.lineNumber !== 'number')
    return undefined;
  if (apply(setHas, ownNames, [at.scriptResourceName]) === true) return undefined;
  if (jsonParseSite(error, got))
    return at.scriptResourceName === undefined ? answer(at) : undefined;
  const file = scriptOf(site);
  if (at.scriptResourceName !== file || apply(lineOf, site, []) !== at.lineNumber) return undefined;
  return answer(at);
}

function answer(at: Positions): JsErrorSource {
  const out = blank(null) as JsErrorSource;
  out.sourceLine = at.sourceLine as string;
  out.lineNumber = at.lineNumber as number;
  out.startColumn = typeof at.startColumn === 'number' ? at.startColumn : 0;
  return freeze(out);
}

export const nodeErrorSource: ((error: unknown) => JsErrorSource | undefined) | undefined =
  found?.positions ? errorSourceOf : undefined;
