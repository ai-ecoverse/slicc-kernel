import { type FsStat, inodeOf, type KernelFs, lutimesOf, mayLink, rangedOps } from './types.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const COMMAND = /^\/(?:usr\/)?bin\/([^/]+)$/;
const MAX_LINKS = 40;

function missing(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'ENOENT';
}

function synthetic(directory: boolean, path: string): FsStat {
  const epoch = new Date(0);
  return {
    isFile: !directory,
    isDirectory: directory,
    isSymbolicLink: false,
    size: 0,
    mode: (directory ? S_IFDIR : S_IFREG) | 0o755,
    mtime: epoch,
    atime: epoch,
    ctime: epoch,
    ino: inodeOf(path),
  };
}

export async function followLinks(fs: KernelFs, path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < MAX_LINKS; hops++) {
    const st = await fs.lstat(current).catch(() => undefined);
    if (!st?.isSymbolicLink) return current;
    const parent = current.slice(0, current.lastIndexOf('/')) || '/';
    current = fs.resolvePath(parent, await fs.readlink(current));
  }
  return current;
}

export type UserCommandDir = (dir: string) => Promise<ReadonlySet<string> | undefined>;

export function withCommandDirs(
  fs: KernelFs,
  names: () => Promise<ReadonlySet<string>>,
  userDir: UserCommandDir = async () => undefined,
  owners = false
): KernelFs {
  async function nearest(path: string): Promise<Partial<FsStat>> {
    const st = await fs.stat(path).catch(() => undefined);
    if (st || path === '/') return st ?? {};
    return nearest(path.slice(0, path.lastIndexOf('/')) || '/');
  }

  async function owned(stat: FsStat, dir?: string): Promise<FsStat> {
    if (!owners) return stat;
    const { uid = 0, gid = 0 } = dir === undefined ? {} : await nearest(dir);
    return { ...stat, uid, gid };
  }

  async function children(path: string): Promise<string[] | undefined> {
    if (path === '/') return ['bin', 'usr'];
    if (path === '/usr') return ['bin'];
    if (path === '/bin' || path === '/usr/bin') return [...(await names())];
    const own = await userDir(path);
    return own?.size ? [...own] : undefined;
  }

  async function virtual(path: string): Promise<FsStat | undefined> {
    if (path === '/usr' || path === '/bin' || path === '/usr/bin') {
      return owned(synthetic(true, path));
    }
    const name = COMMAND.exec(path)?.[1];
    if (name !== undefined) {
      return (await names()).has(name) ? owned(synthetic(false, path)) : undefined;
    }
    if ((await userDir(path))?.size) return owned(synthetic(true, path), path);
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash);
    const own = await userDir(dir);
    return own?.has(path.slice(slash + 1)) ? owned(synthetic(false, path), dir) : undefined;
  }

  async function linked(path: string): Promise<FsStat | undefined> {
    return (await virtual(path)) ?? virtual(await followLinks(fs, path));
  }

  async function stat(path: string, real: (path: string) => Promise<FsStat>): Promise<FsStat> {
    try {
      return await real(path);
    } catch (err) {
      const found = missing(err) ? await linked(path) : undefined;
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
        if (missing(err) && (await linked(path))?.isFile) return new Uint8Array(0);
        throw err;
      }
    },
    writeFile: (path, content, owner) => fs.writeFile(path, content, owner),
    link: (from, to, follow) => fs.link(from, to, follow),
    links: (path) => mayLink(fs, path),
    async exists(path) {
      return (await fs.exists(path)) || (await linked(path)) !== undefined;
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
    async readdirStat(path) {
      const extra = await children(path);
      if (!extra) return fs.readdirStat(path);
      const real = await fs.readdirStat(path).catch((err) => {
        if (missing(err)) return [];
        throw err;
      });
      const seen = new Set(real.map(([name]) => name));
      const base = path === '/' ? '' : path;
      const added = extra.filter((name) => !seen.has(name));
      const virtuals = await Promise.all(
        added.map(
          async (name): Promise<[string, FsStat | null]> => [
            name,
            (await virtual(`${base}/${name}`)) as FsStat,
          ]
        )
      );
      return [...real, ...virtuals].sort(([a], [b]) => (a < b ? -1 : 1));
    },
    mkdir: (path, options) => fs.mkdir(path, options),
    rm: (path, options) => fs.rm(path, options),
    rename: (from, to) => fs.rename(from, to),
    symlink: (target, path, owner) => fs.symlink(target, path, owner),
    readlink: (path) => fs.readlink(path),
    ...(fs.realpath ? { realpath: fs.realpath.bind(fs) } : {}),
    ...(fs.chown ? { chown: fs.chown.bind(fs) } : {}),
    ...(fs.ancestry ? { ancestry: fs.ancestry.bind(fs) } : {}),
    chmod: (path, mode) => fs.chmod(path, mode),
    utimes: (path, atime, mtime) => fs.utimes(path, atime, mtime),
    lutimes: (path, atime, mtime) => lutimesOf(fs, path, atime, mtime),
    ...(rangedOps(fs) ?? {}),
  };
}
