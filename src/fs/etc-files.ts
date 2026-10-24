import {
  type FsStat,
  fsError,
  inodeOf,
  type KernelFs,
  type PwriteOptions,
  rangedOps,
} from './types.ts';

export const HOSTNAME_PATH = '/etc/hostname';

const S_IFREG = 0o100000;
const MAX_HOPS = 40;

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

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

function linkFollower(fs: KernelFs, files: ReadonlyMap<string, () => string>) {
  const bases = new Set([...files.keys()].map(baseOf));
  const linkOf = (path: string) =>
    fs.readlink(path).then(
      (link) => link,
      () => undefined
    );
  const viaParent = async (path: string): Promise<string> => {
    if (!bases.has(baseOf(path)) || !fs.realpath) return path;
    const parent = parentOf(path);
    const dir = await fs.realpath(parent, true).catch(() => parent);
    return fs.resolvePath(dir, baseOf(path));
  };
  return async (path: string): Promise<string> => {
    let current = path;
    for (let hop = 0; hop < MAX_HOPS && !files.has(current); hop++) {
      const link = await linkOf(current);
      if (link === undefined) return viaParent(current);
      current = fs.resolvePath(parentOf(current), link);
    }
    return current;
  };
}

function materializer(
  fs: KernelFs,
  listedAbsent: (path: string) => Promise<Uint8Array | undefined>
) {
  return async (path: string): Promise<void> => {
    const bytes = await listedAbsent(path);
    if (bytes !== undefined) await fs.writeFile(path, bytes);
  };
}

export function withEtcFiles(fs: KernelFs, files: ReadonlyMap<string, () => string>): KernelFs {
  const bytesOf = (path: string): Uint8Array | undefined => {
    const text = files.get(path)?.();
    return text === undefined ? undefined : new TextEncoder().encode(text);
  };
  const absent = (path: string) => fs.lstat(path).then(() => false, missing);
  const follow = linkFollower(fs, files);
  const listedAbsent = async (path: string) =>
    files.has(path) && (await absent(path)) ? bytesOf(path) : undefined;
  const fallback =
    <T>(path: string, make: (bytes: Uint8Array, at: string) => T) =>
    async (err: unknown): Promise<T> => {
      const at = missing(err) ? await follow(path) : undefined;
      const bytes = at === undefined ? undefined : await listedAbsent(at);
      if (bytes === undefined || at === undefined) throw err;
      return make(bytes, at);
    };
  const ranged = rangedOps(fs);
  const materialize = materializer(fs, listedAbsent);
  const own: Partial<KernelFs> = {
    stat: (path) => fs.stat(path).catch(fallback(path, (b, at) => statOf(at, b))),
    lstat: (path) => fs.lstat(path).catch(fallback(path, (b, at) => statOf(at, b))),
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
    ...(fs.append
      ? {
          append: async (path: string, bytes: Uint8Array, options?: PwriteOptions) => {
            if (files.has(path)) await materialize(path);
            return (fs.append as NonNullable<KernelFs['append']>).call(fs, path, bytes, options);
          },
        }
      : {}),
    readFileBuffer: (path) => fs.readFileBuffer(path).catch(fallback(path, (b) => b)),
    ...(ranged
      ? {
          pread: (path: string, offset: number, length: number, version?: string) =>
            ranged
              .pread(path, offset, length, version)
              .catch(fallback(path, (b) => b.slice(offset, offset + length))),
          pwrite: async (
            path: string,
            offset: number,
            bytes: Uint8Array,
            transfer?: boolean,
            options?: PwriteOptions
          ) => {
            if (files.has(path)) await materialize(path);
            return ranged.pwrite(path, offset, bytes, transfer, options);
          },
          truncate: async (path: string, size: number) => {
            if (files.has(path)) await materialize(path);
            return ranged.truncate(path, size);
          },
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
