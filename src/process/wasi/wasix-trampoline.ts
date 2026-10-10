import type { FuncSig, ValType } from './wasm-functypes.ts';

export type Scalar = 'i32' | 'i64' | 'f32' | 'f64' | 'v128';

const CODES: readonly Scalar[] = ['i32', 'i64', 'f32', 'f64', 'v128'];

const VALTYPE: Readonly<Record<Scalar, number>> = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  v128: 0x7b,
};

const SIZE: Readonly<Record<Scalar, number>> = { i32: 4, i64: 8, f32: 4, f64: 8, v128: 16 };

const STORE: Readonly<Record<Scalar, number[]>> = {
  i32: [0x36],
  i64: [0x37],
  f32: [0x38],
  f64: [0x39],
  v128: [0xfd, 0x0b],
};

const LOAD: Readonly<Record<Scalar, number[]>> = {
  i32: [0x28],
  i64: [0x29],
  f32: [0x2a],
  f64: [0x2b],
  v128: [0xfd, 0x00],
};

export function valueTypes(codes: Uint8Array): Scalar[] | undefined {
  const out: Scalar[] = [];
  for (const code of codes) {
    const type = CODES[code];
    if (!type) return undefined;
    out.push(type);
  }
  return out;
}

function u32(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

function s32(n: number): number[] {
  const out: number[] = [];
  let v = n | 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

function name(s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, body: number[]): number[] {
  return [id, ...u32(body.length), ...body];
}

function vec(items: number[][]): number[] {
  return [...u32(items.length), ...items.flat()];
}

function align16(n: number): number {
  return Math.ceil(n / 16) * 16;
}

export function trampolineBytes(
  params: Scalar[],
  results: Scalar[],
  shared: boolean
): Uint8Array<ArrayBuffer> {
  const sig = [
    0x60,
    ...vec(params.map((t) => [VALTYPE[t]])),
    ...vec(results.map((t) => [VALTYPE[t]])),
  ];
  const backing = [0x60, ...vec([[0x7f], [0x7f], [0x7f]]), ...vec([])];
  const memory = shared ? [0x03, 0x00, ...u32(65536)] : [0x00, 0x00];
  const imports = vec([
    [...name('env'), ...name('memory'), 0x02, ...memory],
    [...name('env'), ...name('__indirect_function_table'), 0x01, 0x70, 0x00, 0x00],
    [...name('env'), ...name('__stack_pointer'), 0x03, 0x7f, 0x01],
    [...name('env'), ...name('backing'), 0x03, 0x7f, 0x00],
    [...name('env'), ...name('user_data'), 0x03, 0x7f, 0x00],
  ]);
  const n = params.length;
  const [orig, args, res] = [n, n + 1, n + 2];
  const valuesSize = align16(params.reduce((sum, t) => sum + SIZE[t], 0));
  const resultsSize = align16(results.reduce((sum, t) => sum + SIZE[t], 0));
  const body: number[] = [
    0x23,
    0,
    0x22,
    ...u32(orig),
    0x41,
    ...s32(resultsSize),
    0x6b,
    0x22,
    ...u32(res),
  ];
  body.push(0x41, ...s32(valuesSize), 0x6b, 0x22, ...u32(args), 0x24, 0);
  let at = 0;
  params.forEach((t, i) => {
    body.push(0x20, ...u32(args), 0x20, ...u32(i), ...STORE[t], 0, ...u32(at));
    at += SIZE[t];
  });
  body.push(0x20, ...u32(args), 0x20, ...u32(res), 0x23, 2, 0x23, 1, 0x11, 1, 0);
  at = 0;
  for (const t of results) {
    body.push(0x20, ...u32(res), ...LOAD[t], 0, ...u32(at));
    at += SIZE[t];
  }
  body.push(0x20, ...u32(orig), 0x24, 0, 0x0b);
  const func = [...vec([[...u32(3), 0x7f]]), ...body];
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, vec([sig, backing])),
    ...section(2, imports),
    ...section(3, vec([[0]])),
    ...section(7, vec([[...name('t'), 0x00, 0x00]])),
    ...section(10, vec([[...u32(func.length), ...func]])),
  ]);
}

export class Trampolines {
  private readonly modules = new Map<string, WebAssembly.Module>();

  get compiled(): number {
    return this.modules.size;
  }

  make(
    params: Scalar[],
    results: Scalar[],
    env: {
      memory: WebAssembly.Memory;
      table: WebAssembly.Table;
      stackPointer: WebAssembly.Global;
      backing: number;
      userData: number;
    }
  ): { fn: (...args: unknown[]) => unknown; sig: FuncSig } {
    const shared = env.memory.buffer instanceof SharedArrayBuffer;
    const key = `${params.join(',')}>${results.join(',')}${shared ? 's' : ''}`;
    let module = this.modules.get(key);
    if (!module) {
      module = new WebAssembly.Module(trampolineBytes(params, results, shared));
      this.modules.set(key, module);
    }
    const i32 = (v: number) => new WebAssembly.Global({ value: 'i32', mutable: false }, v);
    const instance = new WebAssembly.Instance(module, {
      env: {
        memory: env.memory,
        __indirect_function_table: env.table,
        __stack_pointer: env.stackPointer,
        backing: i32(env.backing),
        user_data: i32(env.userData),
      },
    });
    const sig: FuncSig = {
      params: params.map((t) => (t === 'v128' ? 'other' : t)) as ValType[],
      results: results.map((t) => (t === 'v128' ? 'other' : t)) as ValType[],
    };
    return { fn: instance.exports.t as (...args: unknown[]) => unknown, sig };
  }
}
