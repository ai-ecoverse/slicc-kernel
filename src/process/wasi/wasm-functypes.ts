export type ValType = 'i32' | 'i64' | 'f32' | 'f64' | 'other';

export interface FuncSig {
  params: ValType[];
  results: ValType[];
}

export interface ElemSegment {
  offset: number;
  tableBase: boolean;
  funcs: number[];
}

export interface FuncTypeInfo {
  sigs: FuncSig[];
  funcs: number[];
  exports: Record<string, number>;
  elems: ElemSegment[];
}

const VALTYPES: Readonly<Record<number, ValType>> = {
  127: 'i32',
  126: 'i64',
  125: 'f32',
  124: 'f64',
};

const TABLE_BASE = '__table_base';

class Reader {
  at = 8;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    return this.bytes[this.at++] ?? 0;
  }

  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
  }

  s32(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return shift < 32 && b & 0x40 ? result | (-1 << shift) : result;
  }

  name(): string {
    const len = this.u32();
    const s = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + len));
    this.at += len;
    return s;
  }

  valtype(): ValType {
    const code = this.byte();
    if (code === 0x63 || code === 0x64) this.s32();
    return VALTYPES[code] ?? 'other';
  }

  limits(): void {
    const flags = this.byte();
    this.u32();
    if (flags & 1) this.u32();
  }
}

interface Scan {
  info: FuncTypeInfo;
  globals: Array<string | number | undefined>;
}

function readTypes(r: Reader, s: Scan): void {
  for (let i = r.u32(); i > 0; i--) {
    r.byte();
    const params: ValType[] = [];
    for (let n = r.u32(); n > 0; n--) params.push(r.valtype());
    const results: ValType[] = [];
    for (let n = r.u32(); n > 0; n--) results.push(r.valtype());
    s.info.sigs.push({ params, results });
  }
}

function readImports(r: Reader, s: Scan): void {
  for (let i = r.u32(); i > 0; i--) {
    r.name();
    const field = r.name();
    const kind = r.byte();
    if (kind === 0) s.info.funcs.push(r.u32());
    else if (kind === 1) {
      r.valtype();
      r.limits();
    } else if (kind === 2) r.limits();
    else if (kind === 3) {
      r.valtype();
      r.byte();
      s.globals.push(field);
    } else {
      r.byte();
      r.u32();
    }
  }
}

function readFunctions(r: Reader, s: Scan): void {
  for (let i = r.u32(); i > 0; i--) s.info.funcs.push(r.u32());
}

const SKIP: Readonly<Record<number, (r: Reader) => void>> = {
  66: (r) => r.s32(),
  67: (r) => {
    r.at += 4;
  },
  68: (r) => {
    r.at += 8;
  },
  208: (r) => r.valtype(),
};

function constExpr(r: Reader, s: Scan): { value: number; tableBase: boolean } | undefined {
  let value = 0;
  let tableBase = false;
  let known = true;
  for (;;) {
    const op = r.byte();
    if (op === 0x0b) return known ? { value, tableBase } : undefined;
    if (op === 0x41) value += r.s32();
    else if (op === 0x23) {
      const g = s.globals[r.u32()];
      if (g === TABLE_BASE) tableBase = true;
      else if (typeof g === 'number') value += g;
      else known = false;
    } else if (op === 0xd2) {
      value = r.u32();
    } else if (op in SKIP) {
      SKIP[op]?.(r);
      known = false;
    } else if (op !== 0x6a) {
      r.at = r.bytes.length;
      return undefined;
    }
  }
}

function readGlobals(r: Reader, s: Scan): void {
  for (let i = r.u32(); i > 0; i--) {
    r.valtype();
    r.byte();
    const init = constExpr(r, s);
    s.globals.push(init && !init.tableBase ? init.value : undefined);
  }
}

function readExports(r: Reader, s: Scan): void {
  for (let i = r.u32(); i > 0; i--) {
    const name = r.name();
    const kind = r.byte();
    const index = r.u32();
    if (kind === 0) s.info.exports[name] = index;
  }
}

function readElems(r: Reader, s: Scan): void {
  for (let i = r.u32(); i > 0; i--) {
    const flags = r.u32();
    const active = (flags & 1) === 0;
    const table = flags & 2 ? (active ? r.u32() : 0) : 0;
    const offset = active ? constExpr(r, s) : undefined;
    if (flags & 3) r.valtype();
    const funcs: number[] = [];
    for (let n = r.u32(); n > 0; n--) {
      if (flags & 4) {
        const ref = constExpr(r, s);
        funcs.push(ref ? ref.value : -1);
      } else funcs.push(r.u32());
    }
    if (offset && table === 0) {
      s.info.elems.push({ offset: offset.value, tableBase: offset.tableBase, funcs });
    }
  }
}

const SECTIONS: Readonly<Record<number, (r: Reader, s: Scan) => void>> = {
  1: readTypes,
  2: readImports,
  3: readFunctions,
  6: readGlobals,
  7: readExports,
  9: readElems,
};

export function funcTypeInfo(bytes: Uint8Array): FuncTypeInfo {
  const r = new Reader(bytes);
  const s: Scan = { info: { sigs: [], funcs: [], exports: {}, elems: [] }, globals: [] };
  while (r.at < bytes.length) {
    const id = r.byte();
    const end = r.u32() + r.at;
    SECTIONS[id]?.(r, s);
    r.at = end;
  }
  return s.info;
}

export class FuncTypes {
  private readonly known = new WeakMap<object, FuncSig>();
  private pending: Array<() => void> = [];

  register(
    read: () => Uint8Array | undefined,
    instance: WebAssembly.Instance,
    table: WebAssembly.Table | undefined,
    tableBase: number
  ): void {
    this.pending.push(() => {
      const bytes = read();
      if (bytes) this.add(funcTypeInfo(bytes), instance, table, tableBase);
    });
  }

  add(
    info: FuncTypeInfo,
    instance: WebAssembly.Instance,
    table: WebAssembly.Table | undefined,
    tableBase: number
  ): void {
    const sig = (func: number) => info.sigs[info.funcs[func] ?? -1];
    for (const [name, func] of Object.entries(info.exports)) {
      const fn = instance.exports[name];
      const type = sig(func);
      if (typeof fn === 'function' && type) this.known.set(fn, type);
    }
    if (!table) return;
    for (const seg of info.elems) {
      const start = seg.offset + (seg.tableBase ? tableBase : 0);
      seg.funcs.forEach((func, i) => {
        const type = sig(func);
        const fn = start + i < table.length ? table.get(start + i) : null;
        if (fn && type) this.known.set(fn, type);
      });
    }
  }

  set(fn: object, sig: FuncSig): void {
    this.known.set(fn, sig);
  }

  of(fn: object): FuncSig | undefined {
    const known = this.known.get(fn);
    if (known || this.pending.length === 0) return known;
    const pending = this.pending;
    this.pending = [];
    for (const run of pending) run();
    return this.known.get(fn);
  }
}
