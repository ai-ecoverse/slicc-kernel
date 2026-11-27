import { MemoryBudget } from '../fs/memory-budget.ts';

type Handle = MemoryFile | MemoryDirectory;

const fail = (name: string): never => {
  throw new DOMException(name, name);
};

function valid(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    throw new TypeError(`invalid name: ${name}`);
  }
}

const CHUNK = 1024 * 1024;

function bytesOf(data: unknown): Promise<Uint8Array> | Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Blob) return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data as ArrayBuffer);
}

interface WriteParams {
  type: 'write' | 'seek' | 'truncate';
  data?: unknown;
  position?: number;
  size?: number;
}

const isParams = (data: unknown): data is WriteParams =>
  ['write', 'seek', 'truncate'].includes((data as { type?: unknown } | null)?.type as string) &&
  !(data instanceof Blob);

class Chunks {
  blobs: Blob[];
  size: number;

  constructor(blobs: Blob[] = [], size = 0) {
    this.blobs = blobs;
    this.size = size;
  }

  private pad(index: number, length: number): void {
    const blob = this.blobs[index] ?? new Blob([]);
    if (blob.size < length)
      this.blobs[index] = new Blob([blob, new Uint8Array(length - blob.size)]);
  }

  private grow(end: number): void {
    if (end <= this.size) return;
    const last = Math.floor((end - 1) / CHUNK);
    for (let i = 0; i < last; i++) this.pad(i, CHUNK);
    this.pad(last, end - last * CHUNK);
    this.size = end;
  }

  async write(at: number, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    const first = Math.floor(at / CHUNK);
    for (let i = 0; i < first; i++) this.pad(i, CHUNK);
    for (let done = 0; done < bytes.length; ) {
      const index = Math.floor((at + done) / CHUNK);
      const from = at + done - index * CHUNK;
      const n = Math.min(CHUNK - from, bytes.length - done);
      const view = bytes.subarray(done, done + n);
      const part = (
        view.buffer instanceof ArrayBuffer ? view : view.slice()
      ) as Uint8Array<ArrayBuffer>;
      const old = this.blobs[index];
      if (from === 0 && n >= (old?.size ?? 0)) this.blobs[index] = new Blob([part]);
      else {
        const merged = new Uint8Array(Math.max(old?.size ?? 0, from + n));
        if (old) merged.set(new Uint8Array(await old.arrayBuffer()));
        merged.set(part, from);
        this.blobs[index] = new Blob([merged]);
      }
      done += n;
    }
    this.size = Math.max(this.size, at + bytes.length);
  }

  truncate(size: number): void {
    if (size >= this.size) {
      this.grow(size);
      return;
    }
    const keep = Math.ceil(size / CHUNK);
    this.blobs.length = keep;
    if (keep > 0)
      this.blobs[keep - 1] = (this.blobs[keep - 1] as Blob).slice(0, size - (keep - 1) * CHUNK);
    this.size = size;
  }
}

class MemoryFile {
  readonly kind = 'file';
  name: string;
  parent: MemoryDirectory;
  data = new Chunks();
  private removed = false;
  private staging = new Set<() => void>();

  remove(): void {
    this.removed = true;
    for (const done of this.staging) done();
    this.parent.budget?.resize(this.data.size, 0);
    this.data = new Chunks();
    this.parent.budget?.entry(-1);
  }
  lastModified = Date.now();

  constructor(name: string, parent: MemoryDirectory) {
    this.name = name;
    this.parent = parent;
  }

  async getFile(): Promise<File> {
    if (this.parent.removed || this.parent.children.get(this.name) !== this) fail('NotFoundError');
    return new File(this.data.blobs, this.name, { lastModified: this.lastModified });
  }

  async createWritable({ keepExistingData = false } = {}) {
    const next = keepExistingData ? new Chunks([...this.data.blobs], this.data.size) : new Chunks();
    let position = 0;
    const budget = this.parent.budget;
    let reserved = next.size;
    budget?.resize(0, reserved);
    let ended = false;
    const abort = () => {
      if (ended) return;
      ended = true;
      budget?.resize(reserved, 0);
      this.staging.delete(abort);
    };
    if (budget) this.staging.add(abort);
    const reserve = (size: number) => {
      if (ended || this.removed) fail('NotFoundError');
      budget?.resize(reserved, size);
      reserved = size;
    };
    const truncate = (size: number) => {
      reserve(size);
      next.truncate(size);
    };
    const put = async (data: unknown) => {
      const bytes = await bytesOf(data);
      reserve(Math.max(next.size, position + bytes.length));
      await next.write(position, bytes);
      position += bytes.length;
    };
    return {
      write: async (data: unknown) => {
        if (!isParams(data)) return put(data);
        if (data.type === 'truncate') return truncate(data.size ?? 0);
        position = data.position ?? position;
        if (data.type === 'write') await put(data.data);
      },
      seek: async (at: number) => {
        position = at;
      },
      truncate: async (size: number) => truncate(size),
      close: async () => {
        if (ended || this.removed) fail('NotFoundError');
        budget?.resize(this.data.size, 0);
        ended = true;
        this.staging.delete(abort);
        this.data = next;
        this.lastModified = Date.now();
      },
      abort: async () => abort(),
    };
  }

  async move(parent: MemoryDirectory, name: string): Promise<void> {
    valid(name);
    const old = parent.children.get(name);
    if (old?.kind === 'directory') fail('InvalidModificationError');
    if (old && old !== this && parent.budget) old.remove();
    this.parent.children.delete(this.name);
    this.name = name;
    this.parent = parent;
    parent.children.set(name, this);
  }
}

class MemoryDirectory {
  readonly kind = 'directory';
  name: string;
  parent: MemoryDirectory | null;
  readonly children = new Map<string, Handle>();
  removed = false;

  readonly budget: MemoryBudget | undefined;

  constructor(name: string, parent: MemoryDirectory | null, budget = parent?.budget) {
    this.budget = budget;
    this.name = name;
    this.parent = parent;
  }

  private present(): void {
    if (this.removed) fail('NotFoundError');
  }

  async getDirectoryHandle(name: string, { create = false } = {}): Promise<MemoryDirectory> {
    this.present();
    valid(name);
    const found = this.children.get(name);
    if (found?.kind === 'file') fail('TypeMismatchError');
    if (found) return found as MemoryDirectory;
    if (!create) fail('NotFoundError');
    this.budget?.entry(1);
    const dir = new MemoryDirectory(name, this);
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, { create = false } = {}): Promise<MemoryFile> {
    this.present();
    valid(name);
    const found = this.children.get(name);
    if (found?.kind === 'directory') fail('TypeMismatchError');
    if (found) return found as MemoryFile;
    if (!create) fail('NotFoundError');
    this.budget?.entry(1);
    const file = new MemoryFile(name, this);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, { recursive = false } = {}): Promise<void> {
    this.present();
    valid(name);
    const found = this.children.get(name);
    if (!found) return fail('NotFoundError');
    if (found.kind === 'directory' && found.children.size > 0 && !recursive) {
      fail('InvalidModificationError');
    }
    this.children.delete(name);
    if (found.kind === 'directory' || this.budget) found.remove();
  }

  async resolve(handle: Handle): Promise<string[] | null> {
    const names: string[] = [];
    for (let at: Handle | null = handle; at !== this; at = at.parent) {
      if (!at || (at.kind === 'directory' && at.removed)) return null;
      names.unshift(at.name);
    }
    return names;
  }

  remove(): void {
    this.removed = true;
    for (const child of this.children.values())
      if (child.kind === 'directory' || this.budget) child.remove();
    if (this.budget) {
      this.children.clear();
      if (this.parent) this.budget.entry(-1);
    }
  }

  async *keys(): AsyncGenerator<string> {
    this.present();
    for (const name of [...this.children.keys()]) yield name;
  }

  async *values(): AsyncGenerator<Handle> {
    for (const handle of [...this.children.values()]) yield handle;
  }

  async *entries(): AsyncGenerator<[string, Handle]> {
    for (const entry of [...this.children]) yield entry;
  }

  async move(parent: MemoryDirectory, name: string): Promise<void> {
    valid(name);
    if (parent.children.has(name)) fail('InvalidModificationError');
    this.parent?.children.delete(this.name);
    this.name = name;
    this.parent = parent;
    parent.children.set(name, this);
  }
}

export function leaseMemoryRoot() {
  const budget = new MemoryBudget();
  const dir = new MemoryDirectory('', null, budget);
  return {
    root: dir as unknown as FileSystemDirectoryHandle,
    clear() {
      dir.remove();
      budget.close();
    },
  };
}

export function memoryRoot(): FileSystemDirectoryHandle {
  return new MemoryDirectory('', null) as unknown as FileSystemDirectoryHandle;
}

export function isMemoryRoot(handle: FileSystemDirectoryHandle): boolean {
  return (handle as unknown) instanceof MemoryDirectory;
}
