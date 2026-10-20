export function parseFunctionNames(payload: Uint8Array): Map<number, string> {
  const names = new Map<number, string>();
  const decoder = new TextDecoder();
  let at = 0;
  const leb = (): number => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      if (at >= payload.length) throw new RangeError('truncated name section');
      byte = payload[at++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (at < payload.length) {
    const id = payload[at++];
    const size = leb();
    const end = at + size;
    if (end > payload.length) throw new RangeError('truncated name section');
    if (id === 1) {
      for (let count = leb(); count > 0; count--) {
        const index = leb();
        const length = leb();
        if (at + length > end) throw new RangeError('truncated name section');
        names.set(index, decoder.decode(payload.subarray(at, at + length)));
        at += length;
      }
    }
    at = end;
  }
  return names;
}

const UNNAMED_FRAME = /^(\s+at )(wasm:\/\/wasm\/([^\s()]+?):wasm-function\[(\d+)\]:0x[0-9a-f]+)$/;

const WASM_MODULE = /wasm:\/\/wasm\/([^\s()]+?):wasm-function\[/;

export function mainModule(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = WASM_MODULE.exec(lines[i] as string);
    if (!m) continue;
    return lines.slice(i + 1).some((line) => /^\s+at /.test(line)) ? m[1] : undefined;
  }
  return undefined;
}

export function nameFrame(
  line: string,
  module: string,
  name: (index: number) => string | undefined
): string {
  const m = UNNAMED_FRAME.exec(line);
  if (!m || m[3] !== module) return line;
  const found = name(Number(m[4]));
  return found === undefined ? line : `${m[1]}${found} (${m[2]})`;
}

export function definedFunctions(bytes: Uint8Array): number {
  let at = 8;
  const leb = (): number => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      if (at >= bytes.length) throw new RangeError('truncated module');
      byte = bytes[at++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = leb();
    if (id === 3) return leb();
    at += size;
  }
  return 0;
}

export interface SidecarFit {
  functions(): number;
  warn(line: string): void;
}

export function sidecarNames(
  read: (path: string) => Uint8Array,
  path: string,
  fit?: SidecarFit
): (index: number) => string | undefined {
  let names: Map<number, string> | undefined;
  return (index) => {
    if (!names) {
      try {
        names = parseFunctionNames(read(path));
      } catch {
        names = new Map();
      }
      const want = fit ? fit.functions() : names.size;
      if (fit && names.size !== want) {
        fit.warn(
          `${path} names ${names.size} functions, but the module has ${want}: it doesn't fit, so the frames show raw indices`
        );
        names = new Map();
      }
    }
    return names.get(index);
  };
}
