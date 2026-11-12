export interface ImageHandle {
  readonly image: string;
}

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function digest(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

const PAGE = 65536;

function leb(bytes: Uint8Array, at: { i: number }): number {
  let result = 0;
  let scale = 1;
  for (;;) {
    const byte = bytes[at.i++] ?? 0;
    result += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return result;
    scale *= 128;
  }
}

function limits(bytes: Uint8Array, at: { i: number }): number {
  const flags = bytes[at.i++] ?? 0;
  const initial = leb(bytes, at);
  if (flags & 1) leb(bytes, at);
  return initial;
}

function skipImport(bytes: Uint8Array, at: { i: number }, kind: number): number | undefined {
  if (kind === 0) leb(bytes, at);
  else if (kind === 1) {
    at.i++;
    limits(bytes, at);
  } else if (kind === 2) return limits(bytes, at);
  else if (kind === 3) at.i += 2;
  else if (kind === 4) {
    at.i++;
    leb(bytes, at);
  }
  return undefined;
}

function importedPages(bytes: Uint8Array, at: { i: number }): number | undefined {
  for (let n = leb(bytes, at); n > 0; n--) {
    at.i += leb(bytes, at);
    at.i += leb(bytes, at);
    const pages = skipImport(bytes, at, bytes[at.i++] ?? 0);
    if (pages !== undefined) return pages;
  }
  return undefined;
}

export function initialMemory(bytes: Uint8Array): number {
  const at = { i: 8 };
  while (at.i < bytes.length) {
    const id = bytes[at.i++];
    const size = leb(bytes, at);
    const end = at.i + size;
    const pages =
      id === 2
        ? importedPages(bytes, at)
        : id === 5 && leb(bytes, at) > 0
          ? limits(bytes, at)
          : undefined;
    if (pages !== undefined) return pages * PAGE;
    at.i = end;
  }
  return 0;
}

export class Images {
  private readonly initial = new Map<string, number>();
  private readonly bytes = new Map<string, ArrayBuffer>();
  private readonly handles = new Map<string, ImageHandle>();

  async register(source: ArrayBuffer | ArrayBufferView): Promise<ImageHandle> {
    const view =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const image = await digest(view);
    const known = this.handles.get(image);
    if (known) return known;
    const handle: ImageHandle = Object.freeze({ image });
    this.bytes.set(image, view.slice().buffer);
    this.initial.set(image, initialMemory(view));
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

  sizeOf(image: string): { initial: number; module: number } {
    return {
      initial: this.initial.get(image) ?? 0,
      module: this.bytes.get(image)?.byteLength ?? 0,
    };
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
