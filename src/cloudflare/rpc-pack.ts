export const PIECE_BYTES = 16 * 2 ** 20;
const OUT_OF_BAND_BYTES = 4096;
const PART = '\u0000slicc-part';

type Binary = ArrayBuffer | ArrayBufferView;

interface Placeholder {
  [PART]: number;
  length: number;
  kind: string;
}

export interface Packed {
  value: unknown;
  pieces: Uint8Array[];
}

const TYPED: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  Uint8Array,
  Int8Array,
  Uint8ClampedArray,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBinary(value: unknown): value is Binary {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function costOf(value: unknown, seen: Set<object>): number {
  if (value === null || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.buffer.byteLength;
  let cost = 0;
  if (Array.isArray(value)) for (const item of value) cost += costOf(item, seen);
  else if (isPlain(value)) for (const item of Object.values(value)) cost += costOf(item, seen);
  return cost;
}

function bytesOf(value: Binary): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function kindOf(value: Binary): string {
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  const name = value.constructor.name;
  return name in TYPED ? name : 'Uint8Array';
}

class Stream {
  readonly pieces: Uint8Array[] = [];
  private current = new Uint8Array(0);
  private used = 0;
  offset = 0;

  write(bytes: Uint8Array): number {
    const at = this.offset;
    for (let done = 0; done < bytes.byteLength; ) {
      if (this.used === this.current.byteLength) {
        this.current = new Uint8Array(PIECE_BYTES);
        this.used = 0;
        this.pieces.push(this.current);
      }
      const n = Math.min(bytes.byteLength - done, this.current.byteLength - this.used);
      this.current.set(bytes.subarray(done, done + n), this.used);
      this.used += n;
      done += n;
    }
    this.offset += bytes.byteLength;
    return at;
  }

  finish(): Uint8Array[] {
    const last = this.pieces.length - 1;
    if (last >= 0) this.pieces[last] = this.pieces[last]!.slice(0, this.used);
    return this.pieces;
  }
}

function rewrite(value: unknown, stream: Stream): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isBinary(value)) {
    const bytes = bytesOf(value);
    if (bytes.byteLength < OUT_OF_BAND_BYTES) {
      return bytes.buffer.byteLength === bytes.byteLength ? value : copyOf(value, bytes);
    }
    const placeholder: Placeholder = {
      [PART]: stream.write(bytes),
      length: bytes.byteLength,
      kind: kindOf(value),
    };
    return placeholder;
  }
  if (Array.isArray(value)) return value.map((item) => rewrite(item, stream));
  if (!isPlain(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = rewrite(item, stream);
  return out;
}

function copyOf(value: Binary, bytes: Uint8Array): Binary {
  return revive(kindOf(value), bytes.slice());
}

function revive(kind: string, bytes: Uint8Array): Binary {
  if (kind === 'ArrayBuffer') return bytes.buffer as ArrayBuffer;
  const make = TYPED[kind] ?? Uint8Array;
  return new make(bytes.buffer as ArrayBuffer);
}

export function pack(value: unknown): Packed {
  if (costOf(value, new Set()) <= PIECE_BYTES) return { value, pieces: [] };
  const stream = new Stream();
  const packed = rewrite(value, stream);
  return { value: packed, pieces: stream.finish() };
}

function joined(pieces: readonly Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0]!;
  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}

function restore(value: unknown, stream: Uint8Array): unknown {
  if (value === null || typeof value !== 'object' || isBinary(value)) return value;
  if (PART in value) {
    const { [PART]: at, length, kind } = value as Placeholder;
    return revive(kind, stream.slice(at, at + length));
  }
  if (Array.isArray(value)) return value.map((item) => restore(item, stream));
  if (!isPlain(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = restore(item, stream);
  return out;
}

export function unpack(value: unknown, pieces: readonly Uint8Array[]): unknown {
  if (pieces.length === 0) return value;
  return restore(value, joined(pieces));
}
