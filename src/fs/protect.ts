import { type IntegrityOptions, integrityUnknown } from './integrity.ts';
import { type FsStat, fsError, type HeldEntry, type KernelFs, normalizePath } from './types.ts';

export interface Protection {
  readonly paths: readonly string[];
  readonly writers?: readonly string[];
  readonly integrity?: IntegrityOptions;
}

export interface ProtectInit {
  paths: string[];
  writers?: string[];
  integrity?: { unknown: 'allow' | 'deny' };
}

export function protectInit(protection: ProtectInit | Protection): ProtectInit {
  const writers = [...writerTags(protection as Protection)];
  const { integrity } = protection;
  return {
    paths: [...protection.paths],
    ...(writers.length > 0 ? { writers } : {}),
    ...(integrity ? { integrity: { unknown: integrityUnknown(integrity) } } : {}),
  };
}

export function writerTags(protection: Protection | undefined): ReadonlySet<string> {
  const writers = protection?.writers ?? [];
  if (!Array.isArray(writers) || writers.some((tag) => typeof tag !== 'string' || tag === '')) {
    throw new TypeError('protect.writers must be a list of process tags');
  }
  return new Set(writers);
}

export function protectedPrefixes(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p.startsWith('/'))) {
    throw new TypeError('protect.paths must be a list of absolute paths');
  }
  return [...new Set(paths.map((p) => normalizePath(p)))];
}

function within(path: string, prefix: string): boolean {
  return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
}

export function isProtected(prefixes: readonly string[], path: string): boolean {
  return prefixes.some((prefix) => within(path, prefix));
}

export function holdsProtected(prefixes: readonly string[], path: string): boolean {
  return prefixes.some((prefix) => within(prefix, path));
}

const MAX_LINKS = 40;

function partsOf(path: string): string[] {
  return path.split('/').filter((p) => p !== '' && p !== '.');
}

function missing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function resolved(
  fs: KernelFs,
  path: string,
  follow: boolean,
  hops: string[] = []
): Promise<string> {
  let done: string[] = [];
  let todo = partsOf(path);
  for (let links = 0; todo.length > 0; ) {
    const part = todo.shift() as string;
    if (part === '..') {
      done.pop();
      continue;
    }
    if (todo.length === 0 && !follow) {
      done.push(part);
      break;
    }
    const at = `/${[...done, part].join('/')}`;
    const st = await fs.lstat(at).catch((err: unknown) => {
      if (missing(err)) return undefined;
      throw err;
    });
    if (!st) {
      return normalizePath([...done, part, ...todo].join('/'));
    }
    if (!st.isSymbolicLink) {
      done.push(part);
      continue;
    }
    if (++links > MAX_LINKS) throw fsError('ELOOP', path);
    hops.push(normalizePath([at, ...todo].join('/')));
    const link = await fs.readlink(at);
    if (link.startsWith('/')) done = [];
    todo = [...partsOf(link), ...todo];
  }
  return `/${done.join('/')}`;
}

export async function namesOf(fs: KernelFs, path: string): Promise<string[]> {
  const lexical = normalizePath(path);
  const hops: string[] = [];
  await resolved(fs, lexical, true, hops).catch(() => undefined);
  return [lexical, ...hops];
}

export class ProtectedFs {
  private readonly prefixes: readonly string[];

  constructor(prefixes: readonly string[]) {
    this.prefixes = prefixes;
  }

  async check(fs: KernelFs, path: string, follow: boolean, whole = false): Promise<void> {
    const lexical = normalizePath(path);
    const real = await resolved(fs, lexical, follow);
    for (const p of new Set([lexical, real])) {
      if (isProtected(this.prefixes, p) || (whole && holdsProtected(this.prefixes, p))) {
        throw fsError('EROFS', path);
      }
    }
  }

  view(fs: KernelFs): KernelFs {
    const check = (path: string, follow: boolean, whole = false) =>
      this.check(fs, path, follow, whole);
    const marked = (path: string, st: FsStat): FsStat =>
      !st.readonly && isProtected(this.prefixes, normalizePath(path))
        ? { ...st, readonly: true }
        : st;
    const own: Partial<KernelFs> = {
      async writeFile(...args: Parameters<KernelFs['writeFile']>) {
        await check(args[0], true);
        return fs.writeFile(...args);
      },
      async mkdir(...args: Parameters<KernelFs['mkdir']>) {
        await check(args[0], false);
        return fs.mkdir(...args);
      },
      async rm(...args: Parameters<KernelFs['rm']>) {
        await check(args[0], false, true);
        return fs.rm(...args);
      },
      async rename(from: string, to: string) {
        await check(from, false, true);
        await check(to, false, true);
        return fs.rename(from, to);
      },
      async link(from: string, to: string, follow?: boolean) {
        await check(from, follow === true);
        await check(to, false);
        return fs.link(from, to, follow);
      },
      async symlink(...args: Parameters<KernelFs['symlink']>) {
        await check(args[1], false);
        return fs.symlink(...args);
      },
      async chmod(path: string, mode: number) {
        await check(path, true);
        return fs.chmod(path, mode);
      },
      async utimes(path: string, atime: Date, mtime: Date) {
        await check(path, true);
        return fs.utimes(path, atime, mtime);
      },
      async mayChange(path: string, follow: boolean) {
        await check(path, follow);
      },
      async stat(path: string) {
        return marked(path, await fs.stat(path));
      },
      async lstat(path: string) {
        return marked(path, await fs.lstat(path));
      },
      async readdirStat(path: string) {
        const dir = normalizePath(path);
        return (await fs.readdirStat(path)).map(([name, st]): [string, FsStat | null] => [
          name,
          st && marked(`${dir}/${name}`, st),
        ]);
      },
      ...(fs.createExclusive
        ? {
            async createExclusive(...args: Parameters<NonNullable<KernelFs['createExclusive']>>) {
              await check(args[0], true);
              return fs.createExclusive?.(...args);
            },
          }
        : {}),
      ...(fs.chown
        ? {
            async chown(...args: Parameters<NonNullable<KernelFs['chown']>>) {
              await check(args[0], args[1].follow !== false);
              return fs.chown?.(...args);
            },
          }
        : {}),
      ...(fs.lutimes
        ? {
            async lutimes(path: string, atime: Date, mtime: Date) {
              await check(path, false);
              return fs.lutimes?.(path, atime, mtime);
            },
          }
        : {}),
      ...(fs.pwrite
        ? {
            async pwrite(...args: Parameters<NonNullable<KernelFs['pwrite']>>) {
              await check(args[0], true);
              return fs.pwrite?.(...args);
            },
          }
        : {}),
      ...(fs.truncate
        ? {
            async truncate(path: string, size: number) {
              await check(path, true);
              return fs.truncate?.(path, size);
            },
          }
        : {}),
      ...(fs.exclusive
        ? {
            async exclusive<T>(
              path: string,
              run: (held: HeldEntry) => Promise<T>,
              follow?: boolean
            ): Promise<T> {
              return (fs.exclusive as NonNullable<KernelFs['exclusive']>)(
                path,
                (held) =>
                  run({
                    ...held,
                    writeFile: async (...args: Parameters<KernelFs['writeFile']>) => {
                      await check(args[0], true);
                      return held.writeFile(...args);
                    },
                  }),
                follow
              );
            },
          }
        : {}),
    };
    const view: Record<string, unknown> = {};
    for (
      let at: object | null = fs;
      at && at !== Object.prototype;
      at = Object.getPrototypeOf(at)
    ) {
      for (const name of Object.getOwnPropertyNames(at)) {
        if (name === 'constructor' || Object.hasOwn(view, name)) continue;
        const value = (fs as unknown as Record<string, unknown>)[name];
        view[name] = typeof value === 'function' ? value.bind(fs) : value;
      }
    }
    return Object.assign(view, own) as unknown as KernelFs;
  }
}
