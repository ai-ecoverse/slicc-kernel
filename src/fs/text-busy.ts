import { fsError, type HeldEntry, type KernelFs, normalizePath } from './types.ts';
import { joinName, parentOf, realTarget } from './walk.ts';

interface Run {
  name: string | undefined;
  readonly id: string | undefined;
}

const within = (path: string, prefix: string) =>
  prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const PLAIN_LIMIT = 4096;

export function busyError(path: string): Error & { code: string } {
  return fsError('ETXTBSY', path);
}

export class TextBusy {
  private readonly fs: KernelFs;
  private readonly linkable: (path: string) => boolean;
  private readonly runs = new Set<Run>();
  private readonly names = new Map<string, number>();
  private readonly bases = new Map<string, number>();
  private readonly ids = new Map<string, number>();
  private readonly plain = new Map<string, number>();
  private epoch = 0;

  constructor(fs: KernelFs, linkable: (path: string) => boolean) {
    this.fs = fs;
    this.linkable = linkable;
  }

  hold(name: string, id?: string): () => void {
    const run: Run = { name, id };
    this.runs.add(run);
    if (id !== undefined) count(this.ids, id, 1);
    this.rebuild(true);
    return () => {
      if (!this.runs.delete(run)) return;
      if (id !== undefined) count(this.ids, id, -1);
      this.rebuild(false);
    };
  }

  renamed(from: string, to: string): void {
    if (from === to || this.runs.size === 0) return;
    let changed = false;
    for (const run of this.runs) {
      if (run.name === undefined) continue;
      if (within(run.name, from)) {
        run.name = to + run.name.slice(from.length);
        changed = true;
      } else if (within(run.name, to)) {
        run.name = undefined;
        changed = true;
      }
    }
    if (changed) this.rebuild(true);
  }

  removed(path: string): void {
    if (this.runs.size === 0) return;
    let changed = false;
    for (const run of this.runs) {
      if (run.name === undefined || !within(run.name, path)) continue;
      run.name = undefined;
      changed = true;
    }
    if (changed) this.rebuild(false);
  }

  async removedAt(path: string): Promise<void> {
    if (this.runs.size === 0) return;
    const at = normalizePath(path);
    this.removed(at);
    const name = baseName(at);
    if (![...this.runs].some((run) => run.name?.split('/').includes(name))) return;
    const dir = await this.real(parentOf(at));
    if (dir !== undefined) this.removed(joinName(dir, name));
  }

  reshaped(): void {
    this.epoch++;
  }

  async check(path: string, resolved = false): Promise<void> {
    if (this.names.size === 0 && this.ids.size === 0) return;
    const at = normalizePath(path);
    if (this.names.has(at)) throw busyError(path);
    if (resolved) {
      if (await this.linked(at)) throw busyError(path);
      return;
    }
    if (this.plain.get(at) === this.epoch) return;
    const shape = this.epoch;
    if (await this.aliased(at)) throw busyError(path);
    if (shape !== this.epoch) return;
    if (this.plain.size >= PLAIN_LIMIT) this.plain.clear();
    this.plain.set(at, shape);
  }

  view(fs: KernelFs): KernelFs {
    const check = (path: string) => this.check(fs.resolvePath('/', path));
    const { pwrite, append, truncate, copyFile, exclusive } = fs;
    const removedAt = (path: string) => this.removedAt(fs.resolvePath('/', path));
    return {
      ...fs,
      mayWrite: (path) => this.check(fs.resolvePath('/', path), true),
      async rm(path, options) {
        await fs.rm(path, options);
        await removedAt(path);
      },
      async writeFile(path, content, owner) {
        await check(path);
        return fs.writeFile(path, content, owner);
      },
      ...(pwrite
        ? {
            async pwrite(path, offset, bytes, transfer, options) {
              await check(path);
              return pwrite.call(fs, path, offset, bytes, transfer, options);
            },
          }
        : {}),
      ...(append
        ? {
            async append(path, bytes, options) {
              await check(path);
              return append.call(fs, path, bytes, options);
            },
          }
        : {}),
      ...(truncate
        ? {
            async truncate(path, size) {
              await check(path);
              return truncate.call(fs, path, size);
            },
          }
        : {}),
      ...(copyFile
        ? {
            async copyFile(from, to, options) {
              if (!options.exclusive) await check(to);
              return copyFile.call(fs, from, to, options);
            },
          }
        : {}),
      ...(exclusive
        ? {
            exclusive<T>(path: string, run: (held: HeldEntry) => Promise<T>, follow?: boolean) {
              return exclusive.call(
                fs,
                path,
                (held: HeldEntry) =>
                  run({
                    ...held,
                    writeFile: async (at, content, owner) => {
                      await check(at);
                      return held.writeFile(at, content, owner);
                    },
                  }),
                follow
              ) as Promise<T>;
            },
          }
        : {}),
    };
  }

  private rebuild(moved: boolean): void {
    this.names.clear();
    this.bases.clear();
    for (const { name } of this.runs) {
      if (name === undefined) continue;
      count(this.names, name, 1);
      count(this.bases, baseName(name), 1);
    }
    if (moved) this.epoch++;
  }

  private async real(at: string): Promise<string | undefined> {
    const { fs } = this;
    const real = fs.realpath ? fs.realpath(at, true) : realTarget(fs, at);
    return real.catch(() => undefined);
  }

  private async aliased(at: string): Promise<boolean> {
    if (this.bases.has(baseName(at))) {
      const real = await this.real(at);
      if (real !== undefined && this.names.has(real)) return true;
    }
    const st = await this.fs.lstat(at).catch(() => undefined);
    if (!st) return false;
    if (st.isSymbolicLink) {
      const real = await this.real(at);
      return real !== undefined && (this.names.has(real) || (await this.linked(real)));
    }
    return this.linkedStat(at, st);
  }

  private async linked(at: string): Promise<boolean> {
    if (this.ids.size === 0 || !this.linkable(at)) return false;
    const st = await this.fs.stat(at).catch(() => undefined);
    return st !== undefined && this.linkedStat(at, st);
  }

  private linkedStat(at: string, st: { ino?: number; dev?: number; nlink?: number }): boolean {
    if (this.ids.size === 0 || st.ino === undefined || (st.nlink ?? 1) < 2) return false;
    return this.linkable(at) && this.ids.has(`${st.dev ?? 0}:${st.ino}`);
  }
}

function count(map: Map<string, number>, key: string, by: number): void {
  const next = (map.get(key) ?? 0) + by;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}
