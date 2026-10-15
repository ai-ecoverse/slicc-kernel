import { type KernelFs, lutimesOf, type NewOwner, normalizePath, rangedOps } from './types.ts';

export type WatchChange = { paths: string[] } | { overflow: true };

export interface WatchOptions {
  recursive?: boolean;
}

interface Watcher {
  paths: string[];
  recursive: boolean;
  notify: (change: WatchChange) => void;
  pending: Set<string>;
  scheduled: boolean;
}

export const WATCH_BATCH_LIMIT = 1000;

const under = (path: string, dir: string) => dir === '/' || path.startsWith(`${dir}/`);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

function touches(watcher: Watcher, changed: string): boolean {
  return watcher.paths.some(
    (watched) =>
      changed === watched ||
      under(watched, changed) ||
      (watcher.recursive ? under(changed, watched) : parentOf(changed) === watched)
  );
}

const REALS_KEPT = 4096;

export class FsWatchers {
  private readonly watchers = new Set<Watcher>();
  private readonly taps: Array<(paths: string[]) => void> = [];
  private readonly reals = new Map<string, string>();

  private readonly reshapes: Array<() => void> = [];

  onReshape(listener: () => void): void {
    this.reshapes.push(listener);
  }

  reshaped(): void {
    this.reals.clear();
    for (const listener of this.reshapes) listener();
  }

  tap(listener: (paths: string[]) => void): void {
    this.taps.push(listener);
  }

  watch(paths: string[], options: WatchOptions, notify: (change: WatchChange) => void): () => void {
    const watcher: Watcher = {
      paths: paths.map(normalizePath),
      recursive: options.recursive === true,
      notify,
      pending: new Set(),
      scheduled: false,
    };
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  changed(...paths: string[]): void {
    for (const tap of this.taps) tap(paths);
    for (const watcher of this.watchers) {
      for (const path of paths) {
        const changed = normalizePath(path);
        if (touches(watcher, changed)) watcher.pending.add(changed);
      }
      if (watcher.pending.size === 0 || watcher.scheduled) continue;
      watcher.scheduled = true;
      setTimeout(() => this.flush(watcher), 0);
    }
  }

  private flush(watcher: Watcher): void {
    watcher.scheduled = false;
    const paths = [...watcher.pending];
    watcher.pending.clear();
    if (!this.watchers.has(watcher)) return;
    watcher.notify(paths.length > WATCH_BATCH_LIMIT ? { overflow: true } : { paths });
  }

  wrap(fs: KernelFs): KernelFs {
    const after =
      <A extends unknown[]>(
        run: (...args: A) => Promise<void>,
        changed: (...args: A) => string[]
      ) =>
      async (...args: A) => {
        try {
          await run(...args);
        } finally {
          this.changed(...changed(...args));
        }
      };
    const reals = this.reals;
    const realOf = async (path: string): Promise<string> => {
      const at = normalizePath(path);
      const known = reals.get(at);
      if (known !== undefined) return known;
      if (!fs.realpath) return at;
      let real: string;
      try {
        real = await fs.realpath(at, true);
      } catch {
        return at;
      }
      if (reals.size >= REALS_KEPT) reals.clear();
      reals.set(at, real);
      return real;
    };
    const content =
      <A extends [string, ...unknown[]]>(run: (...args: A) => Promise<void>) =>
      async (...args: A) => {
        try {
          await run(...args);
        } finally {
          const at = normalizePath(args[0]);
          const real = await realOf(at);
          this.changed(...(real === at ? [at] : [at, real]));
        }
      };
    const reshaping =
      <A extends unknown[]>(run: (...args: A) => Promise<void>) =>
      async (...args: A) => {
        this.reshaped();
        try {
          await run(...args);
        } finally {
          this.reshaped();
        }
      };
    const overrides: Partial<Record<keyof KernelFs, unknown>> = {
      writeFile: content(fs.writeFile.bind(fs)),
      mkdir: async (path: string, options?: { recursive?: boolean; owner?: NewOwner }) => {
        const created: string[] = [];
        if (options?.recursive) {
          const parts = normalizePath(path).split('/').filter(Boolean);
          for (let at = 1; at < parts.length; at++) {
            const ancestor = `/${parts.slice(0, at).join('/')}`;
            if (created.length > 0 || !(await fs.exists(ancestor))) created.push(ancestor);
          }
        }
        try {
          await fs.mkdir(path, options);
        } finally {
          this.changed(...created, path);
        }
      },
      rm: reshaping(after(fs.rm.bind(fs), (path) => [path])),
      rename: reshaping(after(fs.rename.bind(fs), (from, to) => [from, to])),
      link: reshaping(
        after(
          (from: string, to: string, follow?: boolean) => fs.link(from, to, follow),
          (_from, to) => [to]
        )
      ),
      symlink: reshaping(after(fs.symlink.bind(fs), (_target, path) => [path])),
      chmod: after(fs.chmod.bind(fs), (path) => [path]),
      ...(fs.chown ? { chown: after(fs.chown.bind(fs), (path) => [path]) } : {}),
      utimes: after(fs.utimes.bind(fs), (path) => [path]),
      lutimes: after(
        (path: string, atime: Date, mtime: Date) => lutimesOf(fs, path, atime, mtime),
        (path) => [path]
      ),
    };
    const ranged = rangedOps(fs);
    if (ranged) {
      overrides.pwrite = content(ranged.pwrite);
      overrides.truncate = content(ranged.truncate);
    }
    return new Proxy(fs, {
      get(target, key, receiver) {
        if (Object.hasOwn(overrides, key)) return overrides[key as keyof KernelFs];
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}
