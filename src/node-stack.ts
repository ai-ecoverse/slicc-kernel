import { createRequire } from 'node:module';
import { types } from 'node:util';
import type { JsErrorSource, JsStackFormatter } from './process/js/js-context.ts';

type Prepare = (error: unknown, trace: object[]) => unknown;

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
}

type Binding = (name: string) => { getErrorSourcePositions?: unknown };

export function quietly<T>(target: { emitWarning: unknown }, run: () => T): T {
  const emit = target.emitWarning;
  target.emitWarning = () => {};
  try {
    return run();
  } finally {
    target.emitWarning = emit;
  }
}

export function positionsOf(load: (id: string) => unknown): Internals['positions'] {
  try {
    const { internalBinding } = quietly(
      process,
      () => load('internal/test/binding') as { internalBinding: Binding }
    );
    const get = internalBinding('errors').getErrorSourcePositions;
    return typeof get === 'function' ? (get as Internals['positions']) : undefined;
  } catch {
    return undefined;
  }
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
const isNativeError = types.isNativeError;
const freeze = Object.freeze;
const blank = Object.create;

function internals(): Internals | undefined {
  try {
    const load = createRequire(import.meta.url);
    const errors = load('internal/errors') as {
      setInternalPrepareStackTrace?: unknown;
      defaultPrepareStackTrace?: unknown;
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
    if (typeof set !== 'function' || typeof fallback !== 'function') return undefined;
    return {
      setInternalPrepareStackTrace: set as Internals['setInternalPrepareStackTrace'],
      fallback: fallback as Prepare,
      positions: positionsOf(load),
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

function programName(name: string): boolean {
  return (
    apply(startsWith, name, ['data:']) === true || apply(setHas, programNames, [name]) === true
  );
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

export function keptFrame(site: object): boolean {
  const hash = apply(hashOf, site, []) as string;
  if (hash === ownHash) return false;
  if (apply(isEval, site, []) === true) {
    const origin = apply(originOf, site, []) as string | undefined;
    return typeof origin === 'string' && programName(rootOrigin(origin));
  }
  const file = apply(fileOf, site, []) as unknown;
  if (typeof file !== 'string') return true;
  if (apply(setHas, programHashes, [hash]) === true) return true;
  return apply(startsWith, file, ['node:']) === true || programName(file);
}

export function keptFrames(trace: readonly object[]): object[] {
  const out: object[] = [];
  for (let i = 0; i < trace.length; i++) {
    const site = trace[i] as object;
    if (keptFrame(site)) apply(push, out, [site]);
  }
  return out;
}

let formatter: JsStackFormatter | null = null;
let formatting = false;

const tops = new WeakMap<object, object>();

export function stackDispatcher(fallback: Prepare): Prepare {
  return (error, trace) => {
    if (typeof error === 'object' && error !== null && trace.length > 0) {
      apply(mapSet, tops, [error, trace[0]]);
    }
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

const found = internals();
if (found) found.setInternalPrepareStackTrace(stackDispatcher(found.fallback));

export const nodeStackFormatter:
  | ((fn: JsStackFormatter | null) => JsStackFormatter | null)
  | undefined = found
  ? (fn) => {
      if (fn !== null && typeof fn !== 'function') {
        throw new TypeError('setStackFormatter needs a function or null');
      }
      const previous = formatter;
      formatter = fn;
      return previous;
    }
  : undefined;

export function errorSourceOf(
  positions: (error: object) => Positions | undefined,
  error: unknown
): JsErrorSource | undefined {
  if (typeof error !== 'object' || error === null || !isNativeError(error)) return undefined;
  try {
    void (error as { stack?: unknown }).stack;
  } catch {
    return undefined;
  }
  const site = apply(mapGet, tops, [error]) as object | undefined;
  if (site === undefined || !keptFrame(site)) return undefined;
  const at = positions(error);
  if (!at || typeof at.sourceLine !== 'string' || typeof at.lineNumber !== 'number')
    return undefined;
  if (apply(setHas, ownNames, [at.scriptResourceName]) === true) return undefined;
  const file = apply(isEval, site, []) === true ? undefined : apply(fileOf, site, []);
  if (at.scriptResourceName !== file || apply(lineOf, site, []) !== at.lineNumber) return undefined;
  const out = blank(null) as JsErrorSource;
  out.sourceLine = at.sourceLine;
  out.lineNumber = at.lineNumber;
  out.startColumn = typeof at.startColumn === 'number' ? at.startColumn : 0;
  return freeze(out);
}

const positions = found?.positions;

export const nodeErrorSource: ((error: unknown) => JsErrorSource | undefined) | undefined =
  positions ? (error) => errorSourceOf(positions, error) : undefined;
