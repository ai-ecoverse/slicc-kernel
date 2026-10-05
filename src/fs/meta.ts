export interface MetaEntry {
  path: string;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
  mtimeFor?: number;
  ctimeMs?: number;
  ino?: number;
  link?: string;
  dir?: string;
}

export type MetaChange = (entry: MetaEntry | undefined) => MetaEntry | undefined;

export interface MetaStore {
  get(paths: readonly string[]): Promise<Array<MetaEntry | undefined>>;
  update(path: string, change: MetaChange): Promise<void>;
  move(from: string, to: string, root: (entry: MetaEntry | undefined) => MetaEntry): Promise<void>;
  remove(paths: readonly string[]): Promise<void>;
  links(dir: string): Promise<MetaEntry[]>;
  under(path: string): Promise<MetaEntry[]>;
  all(): Promise<MetaEntry[]>;
}

export const META_DB = 'slicc-kernel';
export const META_VERSION = 1;
export const META_STORE = 'entries';

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function moved(entry: MetaEntry, path: string): MetaEntry {
  return entry.link === undefined ? { ...entry, path } : { ...entry, path, dir: parentOf(path) };
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export class MemoryMeta implements MetaStore {
  private readonly entries = new Map<string, MetaEntry>();

  async get(paths: readonly string[]): Promise<Array<MetaEntry | undefined>> {
    return paths.map((path) => this.entries.get(path));
  }

  async update(path: string, change: MetaChange): Promise<void> {
    this.set(path, change(this.entries.get(path)));
  }

  private set(path: string, entry: MetaEntry | undefined): void {
    if (entry) this.entries.set(path, entry);
    else this.entries.delete(path);
  }

  async move(from: string, to: string, root: (entry: MetaEntry | undefined) => MetaEntry) {
    await this.remove([to]);
    const carried = [...this.entries.values()].filter((entry) => under(entry.path, from));
    for (const entry of carried) this.entries.delete(entry.path);
    for (const entry of carried) {
      const path = to + entry.path.slice(from.length);
      if (path !== to) this.entries.set(path, moved(entry, path));
    }
    this.entries.set(to, moved(root(carried.find((entry) => entry.path === from)), to));
  }

  async remove(paths: readonly string[]): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (paths.some((path) => under(key, path))) this.entries.delete(key);
    }
  }

  async links(dir: string): Promise<MetaEntry[]> {
    return [...this.entries.values()].filter((entry) => entry.dir === dir);
  }

  async under(path: string): Promise<MetaEntry[]> {
    return [...this.entries.values()].filter((entry) => under(entry.path, path));
  }

  async all(): Promise<MetaEntry[]> {
    return [...this.entries.values()];
  }
}

function descendants(path: string): IDBKeyRange {
  return IDBKeyRange.bound(`${path}/`, `${path}0`, false, true);
}

function settle<T>(transaction: IDBTransaction, value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(value());
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('metadata transaction aborted'));
  });
}

interface Invalidation {
  paths?: readonly string[];
  trees?: readonly string[];
}

export class IndexedDbMeta implements MetaStore {
  private readonly db: IDBDatabase;
  private readonly cache = new Map<string, MetaEntry | null>();
  private readonly channel: BroadcastChannel;
  private generation = 0;

  constructor(db: IDBDatabase) {
    this.db = db;
    db.onversionchange = () => db.close();
    this.channel = new BroadcastChannel(`slicc-kernel-meta:${db.name}`);
    this.channel.onmessage = ({ data }) => this.drop(data as Invalidation);
    (this.channel as BroadcastChannel & { unref?: () => void }).unref?.();
  }

  private drop({ paths = [], trees = [] }: Invalidation): void {
    this.generation++;
    for (const path of paths) this.cache.delete(path);
    for (const key of [...this.cache.keys()]) {
      if (trees.some((tree) => under(key, tree))) this.cache.delete(key);
    }
  }

  private changed(invalidation: Invalidation): void {
    this.drop(invalidation);
    this.channel.postMessage(invalidation);
  }

  private transaction(mode: IDBTransactionMode): [IDBTransaction, IDBObjectStore] {
    const transaction = this.db.transaction(META_STORE, mode);
    return [transaction, transaction.objectStore(META_STORE)];
  }

  async get(paths: readonly string[]): Promise<Array<MetaEntry | undefined>> {
    const missing = paths.filter((path) => !this.cache.has(path));
    if (missing.length > 0) {
      const generation = this.generation;
      const [transaction, store] = this.transaction('readonly');
      const found = new Map<string, MetaEntry | null>();
      for (const path of missing) {
        const request = store.get(path);
        request.onsuccess = () => void found.set(path, request.result ?? null);
      }
      await settle(transaction, () => undefined);
      if (generation === this.generation)
        for (const [path, entry] of found) this.cache.set(path, entry);
      return paths.map(
        (path) => (found.has(path) ? found.get(path) : this.cache.get(path)) ?? undefined
      );
    }
    return paths.map((path) => this.cache.get(path) ?? undefined);
  }

  async update(path: string, change: MetaChange): Promise<void> {
    const [transaction, store] = this.transaction('readwrite');
    const request = store.get(path);
    let next: MetaEntry | undefined;
    request.onsuccess = () => {
      next = change(request.result);
      if (next) store.put(next);
      else store.delete(path);
    };
    await settle(transaction, () => undefined);
    this.changed({ paths: [path] });
    this.cache.set(path, next ?? null);
  }

  async move(from: string, to: string, root: (entry: MetaEntry | undefined) => MetaEntry) {
    const [transaction, store] = this.transaction('readwrite');
    store.delete(to);
    store.delete(descendants(to));
    const source = store.get(from);
    const below = store.getAll(descendants(from));
    below.onsuccess = () => {
      store.delete(from);
      store.delete(descendants(from));
      for (const entry of below.result as MetaEntry[]) {
        store.put(moved(entry, to + entry.path.slice(from.length)));
      }
      store.put(moved(root(source.result), to));
    };
    await settle(transaction, () => undefined);
    this.changed({ trees: [from, to] });
  }

  async remove(paths: readonly string[]): Promise<void> {
    const [transaction, store] = this.transaction('readwrite');
    for (const path of paths) {
      store.delete(path);
      store.delete(descendants(path));
    }
    await settle(transaction, () => undefined);
    this.changed({ trees: paths });
  }

  async links(dir: string): Promise<MetaEntry[]> {
    const [transaction, store] = this.transaction('readonly');
    const request = store.index('dir').getAll(dir);
    return settle(transaction, () => request.result as MetaEntry[]);
  }

  async under(path: string): Promise<MetaEntry[]> {
    const [transaction, store] = this.transaction('readonly');
    const self = store.get(path);
    const below = store.getAll(descendants(path));
    return settle(transaction, () =>
      [self.result as MetaEntry | undefined, ...(below.result as MetaEntry[])].filter(
        (entry): entry is MetaEntry => entry !== undefined
      )
    );
  }

  async all(): Promise<MetaEntry[]> {
    const [transaction, store] = this.transaction('readonly');
    const request = store.getAll();
    return settle(transaction, () => request.result as MetaEntry[]);
  }
}

export function openMeta(name: string, factory: IDBFactory): Promise<IndexedDbMeta> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, META_VERSION);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore(META_STORE, { keyPath: 'path' }).createIndex('dir', 'dir');
      }
    };
    request.onsuccess = () => resolve(new IndexedDbMeta(request.result));
    request.onerror = () => reject(request.error);
  });
}
