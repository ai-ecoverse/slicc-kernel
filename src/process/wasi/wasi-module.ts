export interface ImportedMemory {
  module: string;
  name: string;
  initial: number;
  maximum?: number;
  shared: boolean;
}

export function importedMemory(bytes: Uint8Array): ImportedMemory | undefined {
  let at = 8;
  const u32 = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[at++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
  };
  const name = (): string => {
    const len = u32();
    const s = new TextDecoder().decode(bytes.subarray(at, at + len));
    at += len;
    return s;
  };
  const limits = () => {
    const flags = bytes[at++];
    const initial = u32();
    const maximum = flags & 1 ? u32() : undefined;
    return { initial, maximum, shared: (flags & 2) !== 0 };
  };
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = u32();
    const end = at + size;
    if (id !== 2) {
      at = end;
      continue;
    }
    const count = u32();
    for (let i = 0; i < count; i++) {
      const module = name();
      const field = name();
      const kind = bytes[at++];
      if (kind === 0) u32();
      else if (kind === 1) {
        at++;
        limits();
      } else if (kind === 2) {
        const l = limits();
        return { module, name: field, ...l };
      } else if (kind === 3) at += 2;
      else if (kind === 4) {
        at++;
        u32();
      }
    }
    return undefined;
  }
  return undefined;
}

export const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  'wasi_snapshot_preview1',
  'wasix_32v1',
  'wasi',
  'env',
]);

export type ForeignResult = 'none' | 'i32' | 'i64' | 'f32' | 'f64' | 'other';

export type ForeignResults = Record<string, Record<string, ForeignResult>>;

const RESULTS: Readonly<Record<number, ForeignResult>> = {
  127: 'i32',
  126: 'i64',
  125: 'f32',
  124: 'f64',
};

function resultOf(results: number[]): ForeignResult {
  if (results.length === 0) return 'none';
  return (results.length === 1 && RESULTS[results[0]]) || 'other';
}

class Reader {
  at = 8;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    return this.bytes[this.at++];
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

  name(): string {
    const len = this.u32();
    const s = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + len));
    this.at += len;
    return s;
  }

  valtype(): number {
    const code = this.byte();
    if (code === 0x63 || code === 0x64) this.u32();
    return code;
  }

  limits(): void {
    const flags = this.byte();
    this.u32();
    if (flags & 1) this.u32();
  }
}

function readTypes(r: Reader): ForeignResult[] | undefined {
  const types: ForeignResult[] = [];
  for (let i = r.u32(); i > 0; i--) {
    if (r.byte() !== 0x60) return undefined;
    for (let n = r.u32(); n > 0; n--) r.valtype();
    const results: number[] = [];
    for (let n = r.u32(); n > 0; n--) results.push(r.valtype());
    types.push(resultOf(results));
  }
  return types;
}

function skipImport(r: Reader, kind: number): void {
  if (kind === 1) {
    r.valtype();
    r.limits();
  } else if (kind === 2) r.limits();
  else if (kind === 3) {
    r.valtype();
    r.byte();
  } else {
    r.byte();
    r.u32();
  }
}

function readImports(r: Reader, types: ForeignResult[]): ForeignResults {
  const foreign: ForeignResults = {};
  for (let i = r.u32(); i > 0; i--) {
    const module = r.name();
    const field = r.name();
    const kind = r.byte();
    if (kind !== 0) skipImport(r, kind);
    else {
      const type = types[r.u32()] ?? 'other';
      if (!RESERVED_NAMESPACES.has(module)) (foreign[module] ??= {})[field] = type;
    }
  }
  return foreign;
}

export function foreignImports(bytes: Uint8Array): ForeignResults | undefined {
  const r = new Reader(bytes);
  let types: ForeignResult[] | undefined = [];
  while (r.at < bytes.length) {
    const id = r.byte();
    const end = r.u32() + r.at;
    if (id === 1) types = readTypes(r);
    if (!types) return undefined;
    if (id === 2) return readImports(r, types);
    r.at = end;
  }
  return {};
}
