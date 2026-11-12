import type { MetaChange, MetaEntry, MetaStore, MetaUpdate } from '../fs/meta.ts';
import {
  encodeText,
  type SqliteOptions,
  type SqlStorageLike,
  type SqlStore,
  storeOf,
} from './sqlite-store.ts';

export type { SqlCursorLike, SqliteOptions, SqlStorageLike } from './sqlite-store.ts';

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function moved(entry: MetaEntry, path: string): MetaEntry {
  return entry.link === undefined ? { ...entry, path } : { ...entry, path, dir: parentOf(path) };
}

function entryOf(row: Record<string, unknown>): MetaEntry {
  return JSON.parse(String(row.entry)) as MetaEntry;
}

const TREE = '(path = ? OR (path >= ? AND path < ?))';

function treeBindings(path: string): Uint8Array[] {
  return [encodeText(path), encodeText(`${path}/`), encodeText(`${path}0`)];
}

const CACHED = 8192;

function within(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

class SqliteMeta implements MetaStore {
  private readonly store: SqlStore;
  private readonly cache = new Map<string, MetaEntry | null>();

  constructor(store: SqlStore) {
    this.store = store;
  }

  private atomically<T>(fn: () => T): T {
    try {
      return this.store.atomically(fn);
    } catch (err) {
      this.cache.clear();
      throw err;
    }
  }

  private remember(path: string, entry: MetaEntry | null): void {
    if (this.cache.size >= CACHED && !this.cache.has(path)) this.cache.clear();
    this.cache.set(path, entry);
  }

  private read(path: string): MetaEntry | undefined {
    const known = this.cache.get(path);
    if (known !== undefined) return known ?? undefined;
    const row = this.store.row('SELECT entry FROM slicc_meta WHERE path = ?', encodeText(path));
    const entry = row ? entryOf(row) : undefined;
    this.remember(path, entry ?? null);
    return entry;
  }

  private write(path: string, entry: MetaEntry | undefined): void {
    this.remember(path, entry ?? null);
    if (!entry) {
      this.store.run('DELETE FROM slicc_meta WHERE path = ?', encodeText(path));
      return;
    }
    this.store.run(
      'INSERT OR REPLACE INTO slicc_meta (path, dir, entry) VALUES (?, ?, ?)',
      encodeText(path),
      entry.dir === undefined ? null : encodeText(entry.dir),
      JSON.stringify(entry)
    );
  }

  private tree(path: string): MetaEntry[] {
    if (path === '/') return this.store.rows('SELECT entry FROM slicc_meta').map(entryOf);
    return this.store
      .rows(`SELECT entry FROM slicc_meta WHERE ${TREE}`, ...treeBindings(path))
      .map(entryOf);
  }

  private dropTree(path: string): void {
    for (const known of [...this.cache.keys()]) if (within(known, path)) this.cache.delete(known);
    if (path === '/') this.store.run('DELETE FROM slicc_meta');
    else this.store.run(`DELETE FROM slicc_meta WHERE ${TREE}`, ...treeBindings(path));
  }

  async get(paths: readonly string[]): Promise<Array<MetaEntry | undefined>> {
    return paths.map((path) => this.read(path));
  }

  async fresh(paths: readonly string[]): Promise<Array<MetaEntry | undefined>> {
    return this.get(paths);
  }

  async update(path: string, change: MetaChange): Promise<void> {
    this.atomically(() => this.write(path, change(this.read(path))));
  }

  async updateMany(changes: ReadonlyArray<MetaUpdate>): Promise<void> {
    this.atomically(() => {
      for (const { path, change } of changes) this.write(path, change(this.read(path)));
    });
  }

  async move(
    from: string,
    to: string,
    root: (entry: MetaEntry | undefined) => MetaEntry,
    left?: MetaEntry
  ): Promise<void> {
    this.atomically(() => {
      this.dropTree(to);
      const carried = this.tree(from);
      this.dropTree(from);
      for (const entry of carried) {
        const path = to + entry.path.slice(from.length);
        if (path !== to) this.write(path, moved(entry, path));
      }
      this.write(to, moved(root(carried.find((entry) => entry.path === from)), to));
      if (left) this.write(from, left);
    });
  }

  async remove(paths: readonly string[], left?: MetaEntry): Promise<void> {
    this.atomically(() => {
      for (const path of paths) this.dropTree(path);
      if (left) this.write(left.path, left);
    });
  }

  absent(path: string): boolean {
    return this.read(path) === undefined;
  }

  async links(dir: string): Promise<MetaEntry[]> {
    return this.store
      .rows('SELECT entry FROM slicc_meta WHERE dir = ?', encodeText(dir))
      .map(entryOf);
  }

  async under(path: string): Promise<MetaEntry[]> {
    return this.store
      .rows(`SELECT entry FROM slicc_meta WHERE ${TREE}`, ...treeBindings(path))
      .map(entryOf);
  }

  async all(): Promise<MetaEntry[]> {
    return this.store.rows('SELECT entry FROM slicc_meta').map(entryOf);
  }
}

const metas = new WeakMap<SqlStore, SqliteMeta>();

export function sqliteMeta(sql: SqlStorageLike, options: SqliteOptions = {}): MetaStore {
  const store = storeOf(sql, options);
  let meta = metas.get(store);
  if (!meta) metas.set(store, (meta = new SqliteMeta(store)));
  return meta;
}
