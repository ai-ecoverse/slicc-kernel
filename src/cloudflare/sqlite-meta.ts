import type { MetaChange, MetaEntry, MetaStore, MetaUpdate } from '../fs/meta.ts';
import { PathMap } from '../fs/path-map.ts';
import {
  decodeText,
  encodeText,
  type Overlay,
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

class SqliteMeta implements MetaStore, Overlay {
  private readonly store: SqlStore;
  private readonly cache = new Map<string, MetaEntry | null>();
  private readonly dirty = new PathMap<MetaEntry | null>();
  private readonly dirtyLinks = new Map<string, Set<string>>();

  constructor(store: SqlStore) {
    this.store = store;
    store.register(this);
  }

  private remember(path: string, entry: MetaEntry | null): void {
    if (this.cache.size >= CACHED && !this.cache.has(path)) this.cache.clear();
    this.cache.set(path, entry);
  }

  private stored(path: string): MetaEntry | undefined {
    const known = this.cache.get(path);
    if (known !== undefined) return known ?? undefined;
    const row = this.store.row('SELECT entry FROM slicc_meta WHERE path = ?', encodeText(path));
    const entry = row ? entryOf(row) : undefined;
    this.remember(path, entry ?? null);
    return entry;
  }

  private read(path: string): MetaEntry | undefined {
    if (this.dirty.has(path)) return this.dirty.get(path) ?? undefined;
    return this.stored(path);
  }

  private write(path: string, entry: MetaEntry | undefined): void {
    const old = this.read(path);
    if (old?.dir !== undefined) this.dirtyLinks.get(old.dir)?.delete(path);
    if (!this.dirty.has(path)) this.store.changed(1, 256);
    this.dirty.set(path, entry ?? null);
    if (entry?.dir !== undefined) {
      let set = this.dirtyLinks.get(entry.dir);
      if (!set) this.dirtyLinks.set(entry.dir, (set = new Set()));
      set.add(path);
    }
  }

  private storedTree(path: string): MetaEntry[] {
    if (path === '/') return this.store.rows('SELECT entry FROM slicc_meta').map(entryOf);
    return this.store
      .rows(`SELECT entry FROM slicc_meta WHERE ${TREE}`, ...treeBindings(path))
      .map(entryOf);
  }

  private tree(path: string): MetaEntry[] {
    const out = this.storedTree(path).filter((entry) => !this.dirty.has(entry.path));
    for (const at of this.dirtyUnder(path)) {
      const entry = this.dirty.get(at);
      if (entry) out.push(entry);
    }
    return out;
  }

  private dirtyUnder(path: string): string[] {
    return path === '/' ? [...this.dirty.keys()] : this.dirty.subtree(path);
  }

  private dropTree(path: string): void {
    const paths =
      path === '/'
        ? this.store.rows('SELECT path FROM slicc_meta')
        : this.store.rows(`SELECT path FROM slicc_meta WHERE ${TREE}`, ...treeBindings(path));
    for (const row of paths) this.write(decodeText(row.path), undefined);
    for (const at of this.dirtyUnder(path)) this.write(at, undefined);
  }

  async get(paths: readonly string[]): Promise<Array<MetaEntry | undefined>> {
    return paths.map((path) => this.read(path));
  }

  async fresh(paths: readonly string[]): Promise<Array<MetaEntry | undefined>> {
    return this.get(paths);
  }

  async update(path: string, change: MetaChange): Promise<void> {
    this.store.batch(() => this.write(path, change(this.read(path))));
  }

  async updateMany(changes: ReadonlyArray<MetaUpdate>): Promise<void> {
    this.store.batch(() => {
      for (const { path, change } of changes) this.write(path, change(this.read(path)));
    });
  }

  async move(
    from: string,
    to: string,
    root: (entry: MetaEntry | undefined) => MetaEntry,
    left?: MetaEntry
  ): Promise<void> {
    this.store.batch(() => {
      this.dropTree(to);
      const carried = this.tree(from);
      const source = carried.find((entry) => entry.path === from);
      const placed = root(source);
      this.dropTree(from);
      for (const entry of carried) {
        const path = to + entry.path.slice(from.length);
        if (path !== to) this.write(path, moved(entry, path));
      }
      this.write(to, moved(placed, to));
      if (left) this.write(from, left);
    });
  }

  async remove(paths: readonly string[], left?: MetaEntry): Promise<void> {
    this.store.batch(() => {
      for (const path of paths) this.dropTree(path);
      if (left) this.write(left.path, left);
    });
  }

  absent(path: string): boolean {
    return this.read(path) === undefined;
  }

  async links(dir: string): Promise<MetaEntry[]> {
    const dirty = this.dirtyLinks.get(dir);
    const out = this.store
      .rows('SELECT entry FROM slicc_meta WHERE dir = ?', encodeText(dir))
      .map(entryOf)
      .filter((entry) => !this.dirty.has(entry.path));
    if (dirty) {
      for (const path of dirty) {
        const entry = this.dirty.get(path);
        if (entry && entry.dir === dir) out.push(entry);
      }
    }
    return out;
  }

  async under(path: string): Promise<MetaEntry[]> {
    return this.tree(path).filter((entry) => within(entry.path, path));
  }

  async all(): Promise<MetaEntry[]> {
    return this.tree('/');
  }

  flushInto(store: SqlStore): void {
    for (const [path, entry] of this.dirty.entries()) {
      if (!entry) {
        store.run('DELETE FROM slicc_meta WHERE path = ?', encodeText(path));
        continue;
      }
      store.run(
        'INSERT OR REPLACE INTO slicc_meta (path, dir, entry) VALUES (?, ?, ?)',
        encodeText(path),
        entry.dir === undefined ? null : encodeText(entry.dir),
        JSON.stringify(entry)
      );
    }
  }

  flushed(): void {
    for (const [path, entry] of this.dirty.entries()) this.remember(path, entry);
    this.dirty.clear();
    this.dirtyLinks.clear();
  }
}

const metas = new WeakMap<SqlStore, SqliteMeta>();

export function sqliteMeta(sql: SqlStorageLike, options: SqliteOptions = {}): MetaStore {
  const store = storeOf(sql, options);
  let meta = metas.get(store);
  if (!meta) metas.set(store, (meta = new SqliteMeta(store)));
  return meta;
}
