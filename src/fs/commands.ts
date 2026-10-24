import type { Cred } from '../kernel/cred.ts';
import { access, R_OK } from './access.ts';
import {
  type FsStat,
  fsError,
  inodeOf,
  type KernelFs,
  lutimesOf,
  mayLink,
  type NewOwner,
  rangedOps,
} from './types.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const COMMAND = /^\/(?:usr\/)?bin\/([^/]+)$/;
const MAX_LINKS = 40;
const BIN_ENTRY = /\/bin\/[^/]+$/;

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

export interface EntryTarget {
  path: string;
  owner?: Cred;
}

export type CommandTarget = (path: string) => Promise<EntryTarget | undefined>;

const NOBODY = { ruid: -1, euid: -1, suid: -1, rgid: -1, egid: -1, sgid: -1, groups: [] };

const EMPTY = new Uint8Array(0);

function quiet<T>(promise: Promise<T>): Promise<T | undefined> {
  return promise.catch(() => undefined);
}

async function readsAs(fs: KernelFs, cred: Readonly<Cred>, target: string): Promise<boolean> {
  const walked = await quiet(access(fs, cred, target, R_OK, { directory: false }));
  return walked !== undefined && walked.denied === undefined && !walked.missing;
}

async function shownTarget(fs: KernelFs, target: string): Promise<FsStat | undefined> {
  const st = await quiet(fs.stat(target));
  return st?.isFile && (await readsAs(fs, NOBODY, target)) ? st : undefined;
}

async function madeFor(
  owner: NewOwner | undefined,
  virtual: () => Promise<unknown>
): Promise<NewOwner | undefined> {
  if (!owner?.existing || (await virtual()) === undefined) return owner;
  const { existing: _, ...made } = owner;
  return made;
}

export function withCommandDirs(
  fs: KernelFs,
  names: () => Promise<ReadonlySet<string>>,
  userDir: UserCommandDir = async () => undefined,
  owners = false,
  targetOf: CommandTarget = async () => undefined
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

  let generation: unknown;
  const targets = new Map<string, Promise<FsStat | undefined>>();
  async function targetStat(target: string): Promise<FsStat | undefined> {
    const now = await names();
    if (now !== generation) {
      generation = now;
      targets.clear();
    }
    let found = targets.get(target);
    if (!found) {
      found = shownTarget(fs, target);
      targets.set(target, found);
    }
    return found;
  }

  async function shown(path: string): Promise<FsStat | undefined> {
    const st = await virtual(path);
    if (!st?.isFile) return st;
    const target = await targetOf(path);
    const real = target === undefined ? undefined : await targetStat(target.path);
    return real
      ? { ...st, size: real.size, mtime: real.mtime, ctime: real.mtime, atime: real.mtime }
      : st;
  }

  async function linked(path: string): Promise<FsStat | undefined> {
    return (await shown(path)) ?? shown(await followLinks(fs, path));
  }

  async function entryTarget(path: string): Promise<EntryTarget | undefined> {
    if (!BIN_ENTRY.test(path) || !(await virtual(path))?.isFile) return undefined;
    if (!(await fs.lstat(path).then(() => false, missing))) return undefined;
    const target = await targetOf(path);
    return target?.path === path ? undefined : target;
  }

  async function redirected(path: string): Promise<string | undefined> {
    const target = (await entryTarget(path)) ?? (await entryTarget(await followLinks(fs, path)));
    if (owners && target?.owner && !(await readsAs(fs, target.owner, target.path))) {
      throw fsError('EACCES', path);
    }
    return target?.path;
  }

  const absent = (err: unknown): Uint8Array => {
    if (missing(err)) return EMPTY;
    throw err;
  };

  async function content(path: string, err: unknown): Promise<Uint8Array> {
    if (!missing(err) || !(await linked(path))?.isFile) throw err;
    const target = await redirected(path);
    return target === undefined ? EMPTY : fs.readFileBuffer(target).catch(absent);
  }

  const ranged = rangedOps(fs);

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
    readFile: (path) =>
      fs.readFile(path).catch(async (err) => {
        if (!BIN_ENTRY.test(await followLinks(fs, path))) throw err;
        return new TextDecoder().decode(await content(path, err));
      }),
    readFileBuffer: (path) => fs.readFileBuffer(path).catch((err) => content(path, err)),
    commandTarget: async (path) => (await entryTarget(path))?.path,
    writeFile: async (path, content, owner) =>
      fs.writeFile(path, content, await madeFor(owner, () => entryTarget(path))),
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
            (await shown(`${base}/${name}`)) as FsStat,
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
    ...(fs.createExclusive ? { createExclusive: fs.createExclusive.bind(fs) } : {}),
    ...(fs.copyFile ? { copyFile: fs.copyFile.bind(fs) } : {}),
    ...(fs.append ? { append: fs.append.bind(fs) } : {}),
    ...(fs.ancestry ? { ancestry: fs.ancestry.bind(fs) } : {}),
    ...(fs.hasOwner ? { hasOwner: fs.hasOwner.bind(fs) } : {}),
    chmod: (path, mode) => fs.chmod(path, mode),
    utimes: (path, atime, mtime) => fs.utimes(path, atime, mtime),
    lutimes: (path, atime, mtime) => lutimesOf(fs, path, atime, mtime),
    ...(ranged
      ? {
          ...ranged,
          pread: (path, offset, length, version) =>
            ranged.pread(path, offset, length, version).catch(async (err) => {
              const target = missing(err) ? await redirected(path) : undefined;
              if (target === undefined) throw err;
              return ranged.pread(target, offset, length).catch(absent);
            }),
        }
      : {}),
  };
}
