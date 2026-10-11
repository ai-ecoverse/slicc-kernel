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

function readSome(view: DataView, at: number, end: number, type: Scalar): Value {
  if (at + SIZE[type] <= end) return read(view, at, type);
  const some = new DataView(new ArrayBuffer(8));
  for (let i = 0; at + i < end; i++) some.setUint8(i, view.getUint8(at + i));
  return read(some, 0, type);
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
  ...operands: [number, number, number, number, number, number]
): void {
  const [id, values, valuesLen, results, resultsLen, strict] = operands.map((n) => n >>> 0);
  const table = ctx.table();
  if (!table) throw new WasiError('ENOTSUP');
  const fn = id < table.length ? table.get(id) : null;
  const sig = fn ? ctx.types.of(fn) : undefined;
  if (!fn || !sig) throw new WasiError('EINVAL');
  const params = scalars(sig.params);
  const outs = scalars(sig.results);
  const size = (types: Scalar[]) => types.reduce((n, type) => n + SIZE[type], 0);
  if (strict && (size(params) !== valuesLen || size(outs) !== resultsLen)) {
    throw new WasiError('EINVAL');
  }
  const view = ctx.mem.view();
  if (values + valuesLen > view.byteLength || results + resultsLen > view.byteLength) {
    throw new WasiError('EFAULT');
  }
  const end = values + valuesLen;
  let at = values;
  const args = params.map((type) => {
    const v = readSome(view, at, end, type);
    at += SIZE[type];
    return v;
  });
  const returned = (fn as (...a: Value[]) => Value | Value[] | undefined)(...args);
  const got = outs.length === 1 ? [returned as Value] : ((returned ?? []) as Value[]);
  const after = ctx.mem.view();
  const stop = results + resultsLen;
  let out = results;
  outs.forEach((type, i) => {
    if (out + SIZE[type] > stop) return;
    write(after, out, type, got[i] as Value);
    out += SIZE[type];
  });
}
