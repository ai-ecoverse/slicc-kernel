import { answerModuleQueries, type WasmInfo, wasmInfo } from './wasm-info.ts';

export interface ImageHandle {
  readonly image: string;
}

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function digest(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

export class Images {
  private readonly bytes = new Map<string, ArrayBuffer>();
  private readonly handles = new Map<string, ImageHandle>();
  private readonly infos = new WeakMap<object, WasmInfo>();
  readonly release = answerModuleQueries((module) =>
    module && typeof module === 'object' ? this.infos.get(module) : undefined
  );

  async register(source: ArrayBuffer | ArrayBufferView): Promise<ImageHandle> {
    const view =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const image = await digest(view);
    const known = this.handles.get(image);
    if (known) return known;
    const handle: ImageHandle = Object.freeze({ image });
    this.infos.set(handle, wasmInfo(view));
    this.bytes.set(image, view.slice().buffer);
    this.handles.set(image, handle);
    return handle;
  }

  compile = async (bytes: ArrayBuffer | ArrayBufferView): Promise<WebAssembly.Module> =>
    (await this.register(bytes)) as unknown as WebAssembly.Module;

  get(image: string): ArrayBuffer {
    const bytes = this.bytes.get(image);
    if (!bytes) throw new Error(`no program image ${image}`);
    return bytes;
  }

  has(image: string): boolean {
    return this.bytes.has(image);
  }

  get size(): number {
    return this.bytes.size;
  }
}

export function imageOf(module: unknown): string | undefined {
  const image = (module as Partial<ImageHandle> | null | undefined)?.image;
  return typeof image === 'string' ? image : undefined;
}
