import {
  type CopyOptions,
  type KernelFs,
  lutimesOf,
  type NewOwner,
  normalizePath,
  type PwriteOptions,
  rangedOps,
} from './types.ts';

export type WatchChange = { paths: string[] } | { overflow: true };

type RmOptions = Parameters<KernelFs['rm']>[1];

export type WatchEventType = 'rename' | 'change';

export type WatchNote =
  | { type: WatchEventType; filename: string; moved?: true; seq: number }
  | { overflow: true; seq: number }
  | { ended: true; seq: number };

export interface TypedWatch {
  next(signal: AbortSignal): Promise<WatchNote[]>;
  close(): void;
  root?(): string;
}

interface Typed {
  roots: string[];
  names: Map<string, string>;
  recursive: boolean;
  directory: boolean;
  notes: WatchNote[];
  overflowed: boolean;
  ended: boolean;
  wake: (() => void) | undefined;
}

export const WATCH_NOTES_LIMIT = 1000;

const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

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

function noted(watch: Typed, note: WatchNote): void {
  if (watch.ended) return;
  if ('ended' in note) {
    watch.notes.push(note);
    watch.ended = true;
    watch.wake?.();
    return;
  }
  if (watch.overflowed) return;
  if (watch.notes.length >= WATCH_NOTES_LIMIT) {
    watch.overflowed = true;
    watch.notes.push({ overflow: true, seq: note.seq });
  } else watch.notes.push(note);
  watch.wake?.();
}

function route(watch: Typed, type: WatchEventType, path: string, seq: number): void {
  for (const root of watch.roots) if (routed(watch, root, type, path, seq)) return;
}

function routed(
  watch: Typed,
  root: string,
  type: WatchEventType,
  path: string,
  seq: number
): boolean {
  if (path === root || (type === 'rename' && root !== '/' && under(root, path))) {
    noted(watch, { type, filename: watch.names.get(root) ?? baseOf(root), seq });
    if (type === 'rename') noted(watch, { ended: true, seq });
    return true;
  }
  if (parentOf(path) === root) noted(watch, { type, filename: baseOf(path), seq });
  else if (watch.recursive && under(path, root)) {
    noted(watch, { type, filename: path.slice(root === '/' ? 1 : root.length + 1), seq });
  } else return false;
  return true;
}

function remapped(root: string, from: string, to: string): string | undefined {
  if (root === from) return to;
  if (from !== '/' && root.startsWith(`${from}/`)) return to + root.slice(from.length);
  return undefined;
}

export class FsWatchers {
  private readonly watchers = new Set<Watcher>();
  private readonly typed = new Set<Typed>();
  private readonly taps: Array<(paths: string[]) => void> = [];
  private readonly reals = new Map<string, string>();
  private seq = 0;

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

  typedWatch(root: string, recursive: boolean, alias?: string, directory = recursive): TypedWatch {
    const main = normalizePath(root);
    const other = alias === undefined ? main : normalizePath(alias);
    const watch: Typed = {
      roots: other === main ? [main] : [main, other],
      names: new Map(),
      recursive,
      directory,
      notes: [],
      overflowed: false,
      ended: false,
      wake: undefined,
    };
    this.typed.add(watch);
    const close = () => {
      this.typed.delete(watch);
      watch.ended = true;
      watch.wake?.();
    };
    return {
      close,
      root: () => watch.roots[0] as string,
      next: async (signal) => {
        while (watch.notes.length === 0 && !watch.ended && !signal.aborted) {
          await new Promise<void>((resolve) => {
            const done = () => {
              watch.wake = undefined;
              signal.removeEventListener('abort', done);
              resolve();
            };
            watch.wake = done;
            signal.addEventListener('abort', done, { once: true });
          });
        }
        const notes = watch.notes.splice(0);
        watch.overflowed = false;
        if (watch.ended) this.typed.delete(watch);
        return notes.length === 0 && watch.ended ? [{ ended: true, seq: this.seq }] : notes;
      },
    };
  }

  private covers(path: string): boolean {
    for (const watch of this.typed) {
      for (const root of watch.roots) {
        if (path === root || parentOf(path) === root || (watch.recursive && under(path, root)))
          return true;
      }
    }
    return false;
  }

  private emit(type: WatchEventType, paths: readonly string[]): void {
    if (this.typed.size === 0) return;
    for (const path of paths) {
      const at = normalizePath(path);
      const seq = ++this.seq;
      for (const watch of [...this.typed]) route(watch, type, at, seq);
    }
  }

  moved(from: string, to: string, seq = ++this.seq): Set<Typed> {
    const source = normalizePath(from);
    const target = normalizePath(to);
    const followed = new Set<Typed>();
    for (const watch of this.typed) {
      const [main] = watch.roots;
      const roots = watch.roots.map((root) => remapped(root, source, target) ?? root);
      if (roots.every((root, i) => root === watch.roots[i])) continue;
      followed.add(watch);
      const names = new Map<string, string>();
      watch.roots.forEach((root, i) => {
        names.set(roots[i] as string, watch.names.get(root) ?? baseOf(root));
      });
      watch.names = names;
      watch.roots = [...new Set(roots)];
      if (main === source) {
        noted(watch, {
          type: 'rename',
          filename: names.get(target) as string,
          moved: true,
          seq,
        });
      }
    }
    return followed;
  }

  private renamed(from: string, to: string): void {
    const first = ++this.seq;
    const followed = this.moved(from, to, first);
    if (this.typed.size === 0) return;
    for (const [i, path] of [from, to].entries()) {
      const at = normalizePath(path);
      const seq = i === 0 ? first : ++this.seq;
      for (const watch of [...this.typed])
        if (!followed.has(watch)) route(watch, 'rename', at, seq);
    }
  }

  heard(type: WatchEventType, paths: readonly string[]): void {
    if (this.typed.size === 0) return;
    for (const path of paths) {
      const at = normalizePath(path);
      const seq = ++this.seq;
      for (const watch of [...this.typed]) {
        if (type === 'rename' && watch.roots.some((root) => at === root || under(root, at)))
          continue;
        if (type === 'change' && watch.directory && watch.roots.includes(at)) continue;
        route(watch, type, at, seq);
      }
    }
  }

  changed(...paths: string[]): void {
    this.report(paths);
    this.emit('change', paths);
  }

  private report(paths: string[], notify = true): void {
    for (const tap of this.taps) tap(paths);
    if (!notify) return;
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
        changed: (...args: A) => string[],
        type: WatchEventType,
        partly: (err: unknown, ...args: A) => boolean = () => false
      ) =>
      async (...args: A) => {
        try {
          await run(...args);
        } catch (err) {
          this.report(changed(...args), partly(err, ...args));
          throw err;
        }
        const paths = changed(...args);
        this.report(paths);
        this.emit(type, paths);
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
      <A extends [string, ...unknown[]]>(
        run: (...args: A) => Promise<void>,
        types: (fresh: boolean, args: A) => WatchEventType[]
      ) =>
      async (...args: A) => {
        const at = normalizePath(args[0]);
        const fresh = this.covers(at) && !(await fs.exists(at).catch(() => true));
        let done = false;
        try {
          await run(...args);
          done = true;
        } finally {
          const real = await realOf(at);
          const paths = real === at ? [at] : [at, real];
          this.report(paths);
          if (done) for (const type of types(fresh, args)) this.emit(type, paths);
        }
      };
    const written = (fresh: boolean): WatchEventType[] =>
      fresh ? ['rename', 'change'] : ['change'];
    const overwritten = (fresh: boolean, args: [string, Uint8Array | string, ...unknown[]]) =>
      fresh || args[1].length === 0 ? written(fresh) : (['change', 'change'] as WatchEventType[]);
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
    const removing = after<[string, RmOptions?]>(
      fs.rm.bind(fs),
      (path) => [path],
      'rename',
      (err, _path, options) =>
        options?.recursive === true && (err as { code?: unknown })?.code !== 'ENOENT'
    );
    const overrides: Partial<Record<keyof KernelFs, unknown>> = {
      writeFile: content(fs.writeFile.bind(fs), overwritten),
      ...(fs.createExclusive
        ? { createExclusive: content(fs.createExclusive.bind(fs), () => ['rename']) }
        : {}),
      ...(fs.copyFile
        ? {
            copyFile: (from: string, to: string, options: CopyOptions) =>
              content(
                (_to: string) => fs.copyFile?.(from, to, options) as Promise<void>,
                written
              )(to),
          }
        : {}),
      mkdir: async (path: string, options?: { recursive?: boolean; owner?: NewOwner }) => {
        const created: string[] = [];
        if (options?.recursive) {
          const parts = normalizePath(path).split('/').filter(Boolean);
          for (let at = 1; at < parts.length; at++) {
            const ancestor = `/${parts.slice(0, at).join('/')}`;
            if (created.length > 0 || !(await fs.exists(ancestor))) created.push(ancestor);
          }
        }
        const fresh = !options?.recursive || (this.typed.size > 0 && !(await fs.exists(path)));
        let done = false;
        try {
          await fs.mkdir(path, options);
          done = true;
        } finally {
          this.report([...created, path]);
          if (done) this.emit('rename', fresh ? [...created, path] : created);
        }
      },
      rm: reshaping(async (path: string, options?: RmOptions) => {
        const absent =
          options?.force === true &&
          (await fs.lstat(path).then(
            () => false,
            () => true
          ));
        return absent ? fs.rm(path, options) : removing(path, options);
      }),
      rename: reshaping(async (from: string, to: string) => {
        let done = false;
        try {
          await fs.rename(from, to);
          done = true;
        } finally {
          this.report([from, to], done);
          if (done) this.renamed(from, to);
        }
      }),
      link: reshaping(
        after(
          (from: string, to: string, follow?: boolean) => fs.link(from, to, follow),
          (_from, to) => [to],
          'rename'
        )
      ),
      symlink: reshaping(after(fs.symlink.bind(fs), (_target, path) => [path], 'rename')),
      chmod: after(fs.chmod.bind(fs), (path) => [path], 'change'),
      ...(fs.chown ? { chown: after(fs.chown.bind(fs), (path) => [path], 'change') } : {}),
      utimes: after(fs.utimes.bind(fs), (path) => [path], 'change'),
      lutimes: after(
        (path: string, atime: Date, mtime: Date) => lutimesOf(fs, path, atime, mtime),
        (path) => [path],
        'change'
      ),
    };
    const { append } = fs;
    if (append) {
      overrides.append = async (path: string, bytes: Uint8Array, options?: PwriteOptions) => {
        let end = 0;
        await content(
          async (_path: string) => {
            end = await append.call(fs, path, bytes, options);
          },
          () => ['change']
        )(path);
        return end;
      };
    }
    const ranged = rangedOps(fs);
    if (ranged) {
      overrides.pwrite = content(ranged.pwrite, () => ['change']);
      overrides.truncate = content(ranged.truncate, () => ['change']);
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
