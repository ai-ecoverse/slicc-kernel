export interface WasmInfo {
  imports: WebAssembly.ModuleImportDescriptor[];
  exports: WebAssembly.ModuleExportDescriptor[];
  sections: Map<string, ArrayBuffer[]>;
}

const KINDS: WebAssembly.ImportExportKind[] = [
  'function',
  'table',
  'memory',
  'global',
  'tag' as never,
];
const decoder = new TextDecoder();

class Reader {
  at = 0;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    const value = this.bytes[this.at++];
    if (value === undefined) throw new RangeError('truncated wasm');
    return value;
  }

  leb(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const byte = this.byte();
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
  }

  name(): string {
    const length = this.leb();
    const text = decoder.decode(this.bytes.subarray(this.at, this.at + length));
    this.at += length;
    return text;
  }

  limits(): void {
    const flags = this.leb();
    this.leb();
    if (flags & 1) this.leb();
  }

  valueType(): void {
    const type = this.byte();
    if (type === 0x63 || type === 0x64) this.leb();
  }
}

function skipDescriptor(reader: Reader, kind: number): void {
  if (kind === 0) reader.leb();
  else if (kind === 1) {
    reader.valueType();
    reader.limits();
  } else if (kind === 2) reader.limits();
  else if (kind === 3) {
    reader.valueType();
    reader.byte();
  } else if (kind === 4) {
    reader.byte();
    reader.leb();
  } else throw new RangeError(`unknown import kind ${kind}`);
}

function importsOf(reader: Reader, info: WasmInfo): void {
  for (let n = reader.leb(); n > 0; n--) {
    const module = reader.name();
    const name = reader.name();
    const kind = reader.byte();
    skipDescriptor(reader, kind);
    info.imports.push({ module, name, kind: KINDS[kind]! });
  }
}

function exportsOf(reader: Reader, info: WasmInfo): void {
  for (let n = reader.leb(); n > 0; n--) {
    const name = reader.name();
    const kind = reader.byte();
    reader.leb();
    info.exports.push({ name, kind: KINDS[kind]! });
  }
}

export function wasmInfo(bytes: Uint8Array): WasmInfo {
  const info: WasmInfo = { imports: [], exports: [], sections: new Map() };
  const reader = new Reader(bytes);
  reader.at = 8;
  while (reader.at < bytes.byteLength) {
    const id = reader.byte();
    const size = reader.leb();
    const end = reader.at + size;
    if (id === 0) {
      const name = reader.name();
      const list = info.sections.get(name) ?? [];
      list.push(bytes.slice(reader.at, end).buffer);
      info.sections.set(name, list);
    } else if (id === 2) importsOf(reader, info);
    else if (id === 7) exportsOf(reader, info);
    reader.at = end;
  }
  return info;
}

type ModuleStatics = Pick<typeof WebAssembly.Module, 'imports' | 'exports' | 'customSections'>;

const lookups = new Set<(module: unknown) => WasmInfo | undefined>();
let original: ModuleStatics | undefined;

function infoOf(module: unknown): WasmInfo | undefined {
  for (const lookup of lookups) {
    const info = lookup(module);
    if (info) return info;
  }
  return undefined;
}

export function answerModuleQueries(lookup: (module: unknown) => WasmInfo | undefined): () => void {
  lookups.add(lookup);
  if (!original) {
    const statics = WebAssembly.Module as unknown as ModuleStatics;
    const saved: ModuleStatics = {
      imports: statics.imports.bind(WebAssembly.Module),
      exports: statics.exports.bind(WebAssembly.Module),
      customSections: statics.customSections.bind(WebAssembly.Module),
    };
    original = saved;
    statics.imports = (module) => infoOf(module)?.imports.slice() ?? saved.imports(module);
    statics.exports = (module) => infoOf(module)?.exports.slice() ?? saved.exports(module);
    statics.customSections = (module, name) =>
      infoOf(module)?.sections.get(name)?.slice() ??
      (infoOf(module) ? [] : saved.customSections(module, name));
  }
  return () => {
    lookups.delete(lookup);
  };
}
