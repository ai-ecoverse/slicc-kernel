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

class SqliteMeta implements MetaStore {
  private readonly store: SqlStore;

  constructor(store: SqlStore) {
    this.store = store;
  }

  private read(path: string): MetaEntry | undefined {
    const row = this.store.row('SELECT entry FROM slicc_meta WHERE path = ?', encodeText(path));
    return row && entryOf(row);
  }

  private write(path: string, entry: MetaEntry | undefined): void {
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
    this.store.atomically(() => this.write(path, change(this.read(path))));
  }

  async updateMany(changes: ReadonlyArray<MetaUpdate>): Promise<void> {
    this.store.atomically(() => {
      for (const { path, change } of changes) this.write(path, change(this.read(path)));
    });
  }

  async move(
    from: string,
    to: string,
    root: (entry: MetaEntry | undefined) => MetaEntry,
    left?: MetaEntry
  ): Promise<void> {
    this.store.atomically(() => {
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
    this.store.atomically(() => {
      for (const path of paths) this.dropTree(path);
      if (left) this.write(left.path, left);
    });
  }

  absent(path: string): boolean {
    return (
      this.store.row('SELECT 1 AS found FROM slicc_meta WHERE path = ?', encodeText(path)) ===
      undefined
    );
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

export function sqliteMeta(sql: SqlStorageLike, options: SqliteOptions = {}): MetaStore {
  return new SqliteMeta(storeOf(sql, options));
}
