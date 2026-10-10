import { WasiError } from './wasi-files.ts';
import type { WasiMemory } from './wasi-memory.ts';
import type { FuncTypes, ValType } from './wasm-functypes.ts';

type Scalar = Exclude<ValType, 'other'>;
type Value = number | bigint;

const SIZE: Readonly<Record<Scalar, number>> = { i32: 4, i64: 8, f32: 4, f64: 8 };

function read(view: DataView, at: number, type: Scalar): Value {
  if (type === 'i32') return view.getInt32(at, true);
  if (type === 'i64') return view.getBigInt64(at, true);
  if (type === 'f32') return view.getFloat32(at, true);
  return view.getFloat64(at, true);
}

function write(view: DataView, at: number, type: Scalar, value: Value): void {
  if (type === 'i32') view.setInt32(at, Number(value), true);
  else if (type === 'i64') view.setBigInt64(at, BigInt(value), true);
  else if (type === 'f32') view.setFloat32(at, Number(value), true);
  else view.setFloat64(at, Number(value), true);
}

function scalars(types: ValType[]): Scalar[] {
  if (types.includes('other')) throw new WasiError('EINVAL');
  return types as Scalar[];
}

export interface FfiContext {
  mem: WasiMemory;
  table(): WebAssembly.Table | undefined;
  types: FuncTypes;
}

export function callDynamic(
  ctx: FfiContext,
  id: number,
  values: number,
  valuesLen: number,
  results: number,
  resultsLen: number,
  strict: number
): void {
  const table = ctx.table();
  if (!table) throw new WasiError('ENOTSUP');
  const fn = id < table.length ? table.get(id) : null;
  const sig = fn ? ctx.types.of(fn) : undefined;
  if (!fn || !sig) throw new WasiError('EINVAL');
  const params = scalars(sig.params);
  const outs = scalars(sig.results);
  const view = ctx.mem.view();
  const end = values + valuesLen;
  let at = values;
  const args = params.map((type) => {
    if (at + SIZE[type] > end) {
      if (strict) throw new WasiError('EINVAL');
      return type === 'i64' ? 0n : 0;
    }
    const v = read(view, at, type);
    at += SIZE[type];
    return v;
  });
  if (strict && at !== end) throw new WasiError('EINVAL');
  const returned = (fn as (...a: Value[]) => Value | Value[] | undefined)(...args);
  const got = outs.length === 1 ? [returned as Value] : ((returned ?? []) as Value[]);
  const after = ctx.mem.view();
  const stop = results + resultsLen;
  let out = results;
  outs.forEach((type, i) => {
    if (out + SIZE[type] > stop) {
      if (strict) throw new WasiError('EINVAL');
      return;
    }
    write(after, out, type, got[i] as Value);
    out += SIZE[type];
  });
  if (strict && out !== stop) throw new WasiError('EINVAL');
}
