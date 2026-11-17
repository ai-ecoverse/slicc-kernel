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

export interface ImageSource {
  readonly path: string;
  read(): Promise<Uint8Array>;
  stale?(): void;
  kept?(): ImageSource[];
}

interface Image {
  readonly handle: ImageHandle;
  readonly initial: number;
  readonly module: number;
  readonly sources: Map<string, ImageSource>;
  bytes?: ArrayBuffer;
}

const viewOf = (source: ArrayBuffer | ArrayBufferView): Uint8Array =>
  source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength &&
  bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);

export class ImageError extends Error {
  readonly code: string;
  readonly exitStatus: number;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.exitStatus = code === 'ENOENT' ? 127 : 126;
  }
}

function unread(path: string, err: unknown): ImageError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ImageError('ENOENT', `${path} is gone since the kernel compiled it`);
  }
  const why = err instanceof Error ? err.message : String(err);
  return new ImageError(typeof code === 'string' ? code : 'EIO', `${path} cannot be read: ${why}`);
}

export class Images {
  private readonly images = new Map<string, Image>();
  private readonly reading = new Map<string, Promise<ArrayBuffer>>();

  async register(source: ArrayBuffer | ArrayBufferView, from?: ImageSource): Promise<ImageHandle> {
    const view = viewOf(source);
    const image = await digest(view);
    const known = this.images.get(image);
    if (known) {
      if (from) known.sources.set(from.path, from);
      else known.bytes ??= view.slice().buffer;
      return known.handle;
    }
    const handle: ImageHandle = Object.freeze({ image });
    this.images.set(image, {
      handle,
      initial: initialMemory(view),
      module: view.byteLength,
      sources: new Map(from ? [[from.path, from]] : []),
      ...(from ? {} : { bytes: view.slice().buffer }),
    });
    return handle;
  }

  compile = async (
    bytes: ArrayBuffer | ArrayBufferView,
    _key?: string,
    from?: ImageSource
  ): Promise<WebAssembly.Module> =>
    (await this.register(bytes, from)) as unknown as WebAssembly.Module;

  load(image: string): Promise<ArrayBuffer> {
    const entry = this.images.get(image);
    if (!entry) return Promise.reject(new ImageError('ENOENT', `no program image ${image}`));
    if (entry.bytes) return Promise.resolve(entry.bytes);
    const known = this.reading.get(image);
    if (known !== undefined) return known;
    const read = this.read(image, entry).finally(() => this.reading.delete(image));
    this.reading.set(image, read);
    return read;
  }

  private async read(image: string, entry: Image): Promise<ArrayBuffer> {
    let failed: ImageError | undefined;
    for (const source of [...entry.sources.values()]) {
      for (const kept of source.kept?.() ?? []) {
        const bytes = await kept.read().catch(() => undefined);
        if (bytes && (await this.matches(bytes, entry, image))) return bufferOf(bytes);
      }
      try {
        const bytes = await source.read();
        if (await this.matches(bytes, entry, image)) return bufferOf(bytes);
        failed ??= new ImageError('ESTALE', `${source.path} changed since the kernel compiled it`);
      } catch (err) {
        failed ??= unread(source.path, err);
      }
      entry.sources.delete(source.path);
      source.stale?.();
    }
    throw failed ?? new ImageError('ENOENT', `no file holds program image ${image}`);
  }

  private async matches(bytes: Uint8Array, entry: Image, image: string): Promise<boolean> {
    return bytes.byteLength === entry.module && (await digest(bytes)) === image;
  }

  get(image: string): ArrayBuffer {
    const bytes = this.images.get(image)?.bytes;
    if (!bytes) throw new Error(`no program image ${image} kept in memory: load() reads it`);
    return bytes;
  }

  sizeOf(image: string): { initial: number; module: number } {
    const entry = this.images.get(image);
    return { initial: entry?.initial ?? 0, module: entry?.module ?? 0 };
  }

  has(image: string): boolean {
    return this.images.has(image);
  }

  get size(): number {
    return this.images.size;
  }

  get held(): number {
    let total = 0;
    for (const entry of this.images.values()) total += entry.bytes?.byteLength ?? 0;
    return total;
  }
}

export function imageOf(module: unknown): string | undefined {
  const image = (module as Partial<ImageHandle> | null | undefined)?.image;
  return typeof image === 'string' ? image : undefined;
}
