type Handle = MemoryFile | MemoryDirectory;

const fail = (name: string): never => {
  throw new DOMException(name, name);
};

function valid(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    throw new TypeError(`invalid name: ${name}`);
  }
}

function bytesOf(data: unknown): Promise<Uint8Array> | Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Blob) return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  return new Uint8Array(data as ArrayBuffer).slice();
}

class MemoryFile {
  readonly kind = 'file';
  name: string;
  parent: MemoryDirectory;
  bytes = new Uint8Array(0);
  lastModified = Date.now();

  constructor(name: string, parent: MemoryDirectory) {
    this.name = name;
    this.parent = parent;
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name, { lastModified: this.lastModified });
  }

  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: unknown) => void chunks.push(await bytesOf(data)),
      close: async () => {
        const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.length;
        }
        this.bytes = out;
        this.lastModified = Date.now();
      },
    };
  }

  async move(parent: MemoryDirectory, name: string): Promise<void> {
    valid(name);
    if (parent.children.get(name)?.kind === 'directory') fail('InvalidModificationError');
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

  constructor(name: string, parent: MemoryDirectory | null) {
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
    if (found.kind === 'directory') found.remove();
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
    for (const child of this.children.values()) if (child.kind === 'directory') child.remove();
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

export function memoryRoot(): FileSystemDirectoryHandle {
  return new MemoryDirectory('', null) as unknown as FileSystemDirectoryHandle;
}
