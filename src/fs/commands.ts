import type { FsStat, KernelFs } from './types.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const COMMAND = /^\/(?:usr\/)?bin\/([^/]+)$/;

function missing(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'ENOENT';
}

function synthetic(directory: boolean): FsStat {
  return {
    isFile: !directory,
    isDirectory: directory,
    isSymbolicLink: false,
    size: 0,
    mode: (directory ? S_IFDIR : S_IFREG) | 0o755,
    mtime: new Date(0),
  };
}

export function withCommandDirs(fs: KernelFs, names: () => Promise<ReadonlySet<string>>): KernelFs {
  async function children(path: string): Promise<string[] | undefined> {
    if (path === '/') return ['bin', 'usr'];
    if (path === '/usr') return ['bin'];
    if (path === '/bin' || path === '/usr/bin') return [...(await names())];
    return undefined;
  }

  async function virtual(path: string): Promise<FsStat | undefined> {
    if (path === '/usr' || path === '/bin' || path === '/usr/bin') return synthetic(true);
    const name = COMMAND.exec(path)?.[1];
    return name !== undefined && (await names()).has(name) ? synthetic(false) : undefined;
  }

  async function stat(path: string, real: (path: string) => Promise<FsStat>): Promise<FsStat> {
    try {
      return await real(path);
    } catch (err) {
      const found = missing(err) ? await virtual(path) : undefined;
      if (found) return found;
      throw err;
    }
  }

  return {
    resolvePath: (base, path) => fs.resolvePath(base, path),
    readFile: (path) => fs.readFile(path),
    async readFileBuffer(path) {
      try {
        return await fs.readFileBuffer(path);
      } catch (err) {
        if (missing(err) && (await virtual(path))?.isFile) return new Uint8Array(0);
        throw err;
      }
    },
    writeFile: (path, content) => fs.writeFile(path, content),
    async exists(path) {
      return (await fs.exists(path)) || (await virtual(path)) !== undefined;
    },
    stat: (path) => stat(path, (p) => fs.stat(p)),
    lstat: (path) => stat(path, (p) => fs.lstat(p)),
    async readdir(path) {
      const extra = await children(path);
      if (!extra) return fs.readdir(path);
      const real = await fs.readdir(path).catch((err) => {
        if (missing(err)) return [];
        throw err;
      });
      return [...new Set([...real, ...extra])].sort();
    },
    mkdir: (path, options) => fs.mkdir(path, options),
    rm: (path, options) => fs.rm(path, options),
    rename: (from, to) => fs.rename(from, to),
    symlink: (target, path) => fs.symlink(target, path),
    readlink: (path) => fs.readlink(path),
    chmod: (path, mode) => fs.chmod(path, mode),
    utimes: (path, atime, mtime) => fs.utimes(path, atime, mtime),
  };
}
