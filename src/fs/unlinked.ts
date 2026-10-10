import type { KernelFs } from './types.ts';

export interface UnlinkedFile {
  size(): Promise<number>;
  pread(max: number, at: number): Promise<Uint8Array>;
  pwrite(bytes: Uint8Array, at: number): Promise<unknown>;
  truncate(size: number): Promise<void>;
}

export class UnlinkedCopy implements UnlinkedFile {
  private data: Uint8Array;
  private length: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.length = data.length;
  }

  async size(): Promise<number> {
    return this.length;
  }

  async pread(max: number, at: number): Promise<Uint8Array> {
    return this.data.slice(Math.min(at, this.length), Math.min(at + max, this.length));
  }

  async pwrite(bytes: Uint8Array, at: number): Promise<void> {
    await this.truncate(Math.max(this.length, at + bytes.length));
    this.data.set(bytes, at);
  }

  async truncate(size: number): Promise<void> {
    if (size > this.data.length) {
      const grown = new Uint8Array(Math.max(size, this.data.length * 2));
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    } else if (size > this.length) {
      this.data.fill(0, this.length, size);
    }
    this.length = size;
  }
}

export interface UnlinkHolder {
  readonly opens: ReadonlyMap<string, number>;
  readonly unlinked: Map<string, UnlinkedFile>;
  owns(path: string): boolean;
}

const within = (path: string, target: string) =>
  path === target || target === '/' || path.startsWith(`${target}/`);

export function keepingUnlinked(
  fs: KernelFs,
  holders: Iterable<UnlinkHolder>,
  kept: (path: string) => UnlinkedFile | undefined = () => undefined
): KernelFs {
  const copyOf = (path: string): Promise<UnlinkedFile | undefined> => {
    const node = kept(path);
    if (node) return Promise.resolve(node);
    return fs.readFileBuffer(path).then(
      (bytes) => new UnlinkedCopy(bytes),
      () => undefined
    );
  };
  const pin = async (target: string): Promise<void> => {
    const copies = new Map<string, Promise<UnlinkedFile | undefined>>();
    for (const holder of holders) {
      if (holder.owns(target)) continue;
      for (const path of holder.opens.keys()) {
        if (!within(path, target) || holder.unlinked.has(path)) continue;
        let copy = copies.get(path);
        if (!copy) {
          copy = copyOf(path);
          copies.set(path, copy);
        }
        const file = await copy;
        if (file) holder.unlinked.set(path, file);
      }
    }
  };
  return {
    ...fs,
    async rm(path, options) {
      await pin(fs.resolvePath('/', path));
      await fs.rm(path, options);
    },
    async rename(from, to) {
      await pin(fs.resolvePath('/', to));
      await fs.rename(from, to);
    },
  };
}
