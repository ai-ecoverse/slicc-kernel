export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
  readonly rowsWritten: number;
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
  transaction?<T>(fn: () => T): T;
}

export interface SqliteOptions {
  transaction?: <T>(fn: () => T) => T;
}

export const SCHEMA_VERSION = 1;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS slicc_schema (part TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS slicc_nodes (id INTEGER PRIMARY KEY, parent INTEGER, name BLOB NOT NULL, dir INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0, modified REAL NOT NULL, version INTEGER NOT NULL DEFAULT 0)',
  'CREATE UNIQUE INDEX IF NOT EXISTS slicc_nodes_child ON slicc_nodes (parent, name)',
  'CREATE TABLE IF NOT EXISTS slicc_chunks (node INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (node, idx))',
  'CREATE TABLE IF NOT EXISTS slicc_staged (writer INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (writer, idx))',
  'CREATE TABLE IF NOT EXISTS slicc_meta (path BLOB PRIMARY KEY, dir BLOB, entry TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS slicc_meta_dir ON slicc_meta (dir)',
];

export class SqlStore {
  readonly sql: SqlStorageLike;
  transaction: (<T>(fn: () => T) => T) | undefined;
  private depth = 0;

  constructor(sql: SqlStorageLike, options: SqliteOptions = {}) {
    this.sql = sql;
    this.transaction = options.transaction ?? sql.transaction?.bind(sql);
    this.migrate();
  }

  rows(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    return this.sql.exec(query, ...bindings).toArray();
  }

  row(query: string, ...bindings: unknown[]): Record<string, unknown> | undefined {
    return this.rows(query, ...bindings)[0];
  }

  run(query: string, ...bindings: unknown[]): number {
    const cursor = this.sql.exec(query, ...bindings);
    cursor.toArray();
    return cursor.rowsWritten;
  }

  atomically<T>(fn: () => T): T {
    if (!this.transaction || this.depth > 0) return fn();
    this.depth++;
    try {
      return this.transaction(fn);
    } finally {
      this.depth--;
    }
  }

  private migrate(): void {
    this.atomically(() => {
      for (const statement of SCHEMA) this.run(statement);
      const found = this.row("SELECT version FROM slicc_schema WHERE part = 'fs'");
      const version = found === undefined ? undefined : Number(found.version);
      if (version !== undefined && version > SCHEMA_VERSION) {
        throw new Error(
          `slicc-kernel: the SQLite file system has schema version ${version}, this build reads up to ${SCHEMA_VERSION}`
        );
      }
      if (version === undefined) {
        this.run("INSERT INTO slicc_schema (part, version) VALUES ('fs', ?)", SCHEMA_VERSION);
      }
    });
  }
}

const stores = new WeakMap<SqlStorageLike, SqlStore>();

export function storeOf(sql: SqlStorageLike, options: SqliteOptions = {}): SqlStore {
  const known = stores.get(sql);
  if (known) {
    if (options.transaction) known.transaction = options.transaction;
    return known;
  }
  const store = new SqlStore(sql, options);
  stores.set(sql, store);
  return store;
}

export function encodeText(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 * i] = code >> 8;
    out[2 * i + 1] = code & 0xff;
  }
  return out;
}

const DECODE_SLICE = 4096;

export function decodeText(value: unknown): string {
  const bytes = bytesOf(value);
  const codes = new Array<number>(bytes.length >> 1);
  for (let i = 0; i < codes.length; i++)
    codes[i] = ((bytes[2 * i] as number) << 8) | (bytes[2 * i + 1] as number);
  let out = '';
  for (let i = 0; i < codes.length; i += DECODE_SLICE) {
    out += String.fromCharCode(...codes.slice(i, i + DECODE_SLICE));
  }
  return out;
}

export function bytesOf(value: unknown): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new TypeError('slicc-kernel: a BLOB column held a value that is not bytes');
}
