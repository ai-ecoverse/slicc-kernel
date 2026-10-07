import { type KernelFs, normalizePath } from './types.ts';

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

export class FsWatchers {
  private readonly watchers = new Set<Watcher>();

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
    const overrides: Partial<Record<keyof KernelFs, unknown>> = {
      writeFile: after(fs.writeFile.bind(fs), (path) => [path]),
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
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
      rm: after(fs.rm.bind(fs), (path) => [path]),
      rename: after(fs.rename.bind(fs), (from, to) => [from, to]),
      symlink: after(fs.symlink.bind(fs), (_target, path) => [path]),
      chmod: after(fs.chmod.bind(fs), (path) => [path]),
      utimes: after(fs.utimes.bind(fs), (path) => [path]),
    };
    return new Proxy(fs, {
      get(target, key, receiver) {
        if (Object.hasOwn(overrides, key)) return overrides[key as keyof KernelFs];
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}
