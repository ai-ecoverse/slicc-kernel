import type { TlsEngineModule } from '../kernel/net/tls-engine.ts';

export type { TlsEngineModule };

export type TlsEngineFactory = (options: {
  wasmBinary: Uint8Array;
  locateFile(path: string): string;
}) => Promise<object>;

type Instantiate = (
  source: BufferSource | WebAssembly.Module,
  imports?: WebAssembly.Imports
) => Promise<unknown>;

const TAG = [0x73, 0x6c, 0x69, 0x63, 0x63, 0x2d, 0x74, 0x6c, 0x73];
const waiting = new Map<number, WebAssembly.Module>();
let tickets = 0;
let real: Instantiate | undefined;

function ticketOf(source: unknown): number | undefined {
  if (!(source instanceof Uint8Array) || source.length !== TAG.length + 4) return undefined;
  if (TAG.some((byte, i) => source[i] !== byte)) return undefined;
  return new DataView(source.buffer, source.byteOffset + TAG.length, 4).getUint32(0);
}

const ticketed: Instantiate = (source, imports) => {
  const module = waiting.get(ticketOf(source) ?? -1);
  if (!module) return (real as Instantiate).call(WebAssembly, source, imports);
  return Promise.resolve({ module, instance: new WebAssembly.Instance(module, imports) });
};

function ticket(module: WebAssembly.Module): { id: number; bytes: Uint8Array } {
  const id = ++tickets;
  const bytes = new Uint8Array(TAG.length + 4);
  bytes.set(TAG);
  new DataView(bytes.buffer).setUint32(TAG.length, id);
  if (waiting.size === 0) {
    real = WebAssembly.instantiate as Instantiate;
    WebAssembly.instantiate = ticketed as typeof WebAssembly.instantiate;
  }
  waiting.set(id, module);
  return { id, bytes };
}

function redeem(id: number): void {
  waiting.delete(id);
  if (waiting.size > 0 || WebAssembly.instantiate !== ticketed) return;
  WebAssembly.instantiate = real as typeof WebAssembly.instantiate;
}

export function compiledTlsEngine(
  factory: TlsEngineFactory,
  module: WebAssembly.Module
): () => Promise<TlsEngineModule> {
  return async () => {
    const { id, bytes } = ticket(module);
    try {
      const engine = await factory({ wasmBinary: bytes, locateFile: (path) => path });
      return engine as TlsEngineModule;
    } finally {
      redeem(id);
    }
  };
}
