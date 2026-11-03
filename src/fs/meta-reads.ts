import type { MetaEntry } from './meta.ts';

export interface Invalidated {
  paths?: readonly string[];
  trees?: readonly string[];
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
const within = (path: string, root: string): boolean =>
  root === '/' || path === root || path.startsWith(`${root}/`);

interface Noted {
  at: number;
  paths: readonly string[];
  trees: readonly string[];
}

export class Invalidations {
  private seq = 0;
  private readonly log: Noted[] = [];
  private readonly open = new Map<number, number>();

  start(): number {
    const at = this.seq;
    this.open.set(at, (this.open.get(at) ?? 0) + 1);
    return at;
  }

  end(at: number): void {
    const left = (this.open.get(at) ?? 1) - 1;
    if (left > 0) this.open.set(at, left);
    else this.open.delete(at);
    const oldest = this.open.keys().next();
    if (oldest.done) this.log.length = 0;
    else while (this.log.length > 0 && (this.log[0] as Noted).at <= oldest.value) this.log.shift();
  }

  note({ paths = [], trees = [] }: Invalidated): void {
    this.seq++;
    if (this.open.size > 0) this.log.push({ at: this.seq, paths, trees });
  }

  private since(at: number, hit: (noted: Noted) => boolean): boolean {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const noted = this.log[i] as Noted;
      if (noted.at <= at) return false;
      if (hit(noted)) return true;
    }
    return false;
  }

  entryStale(at: number, path: string): boolean {
    return this.since(
      at,
      ({ paths, trees }) => paths.includes(path) || trees.some((tree) => within(path, tree))
    );
  }

  listingStale(at: number, dir: string): boolean {
    return this.since(
      at,
      ({ paths, trees }) =>
        paths.some((path) => path !== '/' && parentOf(path) === dir) ||
        trees.some((tree) => within(dir, tree) || (tree !== '/' && parentOf(tree) === dir))
    );
  }
}

export type MetaReadKind = 'entry' | 'links';

interface Wanted<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  at?: number;
}

export interface ReadBatch {
  entries: readonly string[];
  links: readonly string[];
}

export interface ReadResult {
  entries: Map<string, MetaEntry | null>;
  links: Map<string, MetaEntry[]>;
}

export const META_READS_IN_FLIGHT = 4;

export class BatchedReads {
  private readonly run: (batch: ReadBatch) => Promise<ReadResult>;
  private readonly invalidations: Invalidations;
  private readonly keep: (kind: MetaReadKind, key: string, value: unknown) => void;
  private readonly queued: Record<MetaReadKind, Map<string, Wanted<unknown>>> = {
    entry: new Map(),
    links: new Map(),
  };
  private readonly reading: Record<MetaReadKind, Map<string, Wanted<unknown>>> = {
    entry: new Map(),
    links: new Map(),
  };
  private inFlight = 0;

  constructor(
    invalidations: Invalidations,
    run: (batch: ReadBatch) => Promise<ReadResult>,
    keep: (kind: MetaReadKind, key: string, value: unknown) => void
  ) {
    this.invalidations = invalidations;
    this.run = run;
    this.keep = keep;
  }

  entries(paths: readonly string[]): Promise<Map<string, MetaEntry | null>> {
    const wanted = paths.map((path) => [path, this.want('entry', path)] as const);
    this.pump();
    return Promise.all(wanted.map(([, w]) => w.promise)).then(
      (found) => new Map(wanted.map(([path], i) => [path, found[i] as MetaEntry | null]))
    );
  }

  links(dir: string): Promise<MetaEntry[]> {
    const wanted = this.want('links', dir);
    this.pump();
    return wanted.promise as Promise<MetaEntry[]>;
  }

  private stale(kind: MetaReadKind, key: string, at: number): boolean {
    return kind === 'entry'
      ? this.invalidations.entryStale(at, key)
      : this.invalidations.listingStale(at, key);
  }

  private want(kind: MetaReadKind, key: string): Wanted<unknown> {
    const reading = this.reading[kind].get(key);
    if (reading && !this.stale(kind, key, reading.at as number)) return reading;
    const queued = this.queued[kind].get(key);
    if (queued) return queued;
    const made = Promise.withResolvers<unknown>();
    made.promise.catch(() => undefined);
    this.queued[kind].set(key, made);
    return made;
  }

  private pump(): void {
    while (
      this.inFlight < META_READS_IN_FLIGHT &&
      (this.queued.entry.size > 0 || this.queued.links.size > 0)
    ) {
      this.flush();
    }
  }

  private flush(): void {
    const entries = this.queued.entry;
    const links = this.queued.links;
    this.queued.entry = new Map();
    this.queued.links = new Map();
    const at = this.invalidations.start();
    for (const [kind, taken] of [
      ['entry', entries],
      ['links', links],
    ] as const) {
      for (const [key, wanted] of taken) {
        wanted.at = at;
        this.reading[kind].set(key, wanted);
      }
    }
    this.inFlight++;
    const settled = (result: ReadResult | undefined, error?: unknown) => {
      this.inFlight--;
      for (const [kind, taken, found] of [
        ['entry', entries, result?.entries],
        ['links', links, result?.links],
      ] as const) {
        for (const [key, wanted] of taken) {
          if (this.reading[kind].get(key) === wanted) this.reading[kind].delete(key);
          if (!found) {
            wanted.reject(error);
            continue;
          }
          const value = found.get(key) ?? (kind === 'entry' ? null : []);
          if (!this.stale(kind, key, at)) this.keep(kind, key, value);
          wanted.resolve(value);
        }
      }
      this.invalidations.end(at);
      this.pump();
    };
    let reading: Promise<ReadResult>;
    try {
      reading = this.run({ entries: [...entries.keys()], links: [...links.keys()] });
    } catch (error) {
      settled(undefined, error);
      return;
    }
    reading.then(
      (result) => settled(result),
      (error: unknown) => settled(undefined, error)
    );
  }
}
