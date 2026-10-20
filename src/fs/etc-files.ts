import { type FsStat, fsError, inodeOf, type KernelFs, rangedOps } from './types.ts';

export const HOSTNAME_PATH = '/etc/hostname';

const S_IFREG = 0o100000;

function missing(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'ENOENT';
}

function statOf(path: string, bytes: Uint8Array): FsStat {
  const epoch = new Date(0);
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    size: bytes.length,
    mode: S_IFREG | 0o644,
    mtime: epoch,
    atime: epoch,
    ctime: epoch,
    ino: inodeOf(path),
    nlink: 1,
    uid: 0,
    gid: 0,
  };
}

export function withEtcFiles(fs: KernelFs, files: ReadonlyMap<string, () => string>): KernelFs {
  const bytesOf = (path: string): Uint8Array | undefined => {
    const text = files.get(path)?.();
    return text === undefined ? undefined : new TextEncoder().encode(text);
  };
  const absent = (path: string) => fs.lstat(path).then(() => false, missing);
  const fallback =
    <T>(path: string, make: (bytes: Uint8Array) => T) =>
    async (err: unknown): Promise<T> => {
      const bytes =
        missing(err) && files.has(path) && (await absent(path)) ? bytesOf(path) : undefined;
      if (bytes === undefined) throw err;
      return make(bytes);
    };
  const ranged = rangedOps(fs);
  const own: Partial<KernelFs> = {
    stat: (path) => fs.stat(path).catch(fallback(path, (b) => statOf(path, b))),
    lstat: (path) => fs.lstat(path).catch(fallback(path, (b) => statOf(path, b))),
    exists: async (path) => (await fs.exists(path)) || (files.has(path) && (await absent(path))),
    ...(fs.createExclusive
      ? {
          createExclusive: async (
            path: string,
            owner?: Parameters<NonNullable<KernelFs['createExclusive']>>[1]
          ) => {
            if (files.has(path) && (await absent(path))) throw fsError('EEXIST', path);
            return (fs.createExclusive as NonNullable<KernelFs['createExclusive']>).call(
              fs,
              path,
              owner
            );
          },
        }
      : {}),
    readFile: (path) => fs.readFile(path).catch(fallback(path, (b) => new TextDecoder().decode(b))),
    readFileBuffer: (path) => fs.readFileBuffer(path).catch(fallback(path, (b) => b)),
    ...(ranged
      ? {
          pread: (path: string, offset: number, length: number, version?: string) =>
            ranged
              .pread(path, offset, length, version)
              .catch(fallback(path, (b) => b.slice(offset, offset + length))),
        }
      : {}),
  };
  return new Proxy(fs, {
    get(target, key, receiver) {
      if (Object.hasOwn(own, key)) return own[key as keyof KernelFs];
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
