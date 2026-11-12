export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
  readonly rowsWritten: number;
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
  transaction?<T>(fn: () => T): T;
}

export interface WriteBehindOptions {
  idleMs?: number;
  maxMs?: number;
  maxBytes?: number;
  maxEntries?: number;
}

export interface SqliteOptions {
  transaction?: <T>(fn: () => T) => T;
  writeBehind?: boolean | WriteBehindOptions;
}

export interface Overlay {
  flushInto(store: SqlStore): void;
  flushed(): void;
}

interface Behind {
  idleMs: number;
  maxMs: number;
  maxBytes: number;
  maxEntries: number;
}

const BEHIND: Behind = { idleMs: 50, maxMs: 1000, maxBytes: 8 * 1024 * 1024, maxEntries: 4096 };

function behindOf(option: SqliteOptions['writeBehind']): Behind | undefined {
  if (option === undefined || option === false) return undefined;
  const given = option === true ? {} : option;
  const number = (value: number | undefined, fallback: number, name: string) => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`slicc-kernel: writeBehind.${name} must be a non-negative number`);
    }
    return value;
  };
  return {
    idleMs: number(given.idleMs, BEHIND.idleMs, 'idleMs'),
    maxMs: number(given.maxMs, BEHIND.maxMs, 'maxMs'),
    maxBytes: number(given.maxBytes, BEHIND.maxBytes, 'maxBytes'),
    maxEntries: number(given.maxEntries, BEHIND.maxEntries, 'maxEntries'),
  };
}

export interface FlushStats {
  flushes: number;
  pending: boolean;
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
  behind: Behind | undefined;
  private depth = 0;
  private holds = 0;
  private readonly overlays: Overlay[] = [];
  private dirtyBytes = 0;
  private dirtyEntries = 0;
  private firstDirty = 0;
  private lastDirty = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  flushes = 0;

  constructor(sql: SqlStorageLike, options: SqliteOptions = {}) {
    this.sql = sql;
    this.transaction = options.transaction ?? sql.transaction?.bind(sql);
    this.behind = behindOf(options.writeBehind);
    this.migrate();
  }

  configure(options: SqliteOptions): void {
    if (options.transaction) this.transaction = options.transaction;
    if (options.writeBehind !== undefined) {
      this.flush();
      this.behind = behindOf(options.writeBehind);
    }
  }

  register(overlay: Overlay): void {
    this.overlays.push(overlay);
  }

  get dirty(): boolean {
    return this.dirtyEntries > 0;
  }

  changed(entries: number, bytes: number): void {
    const now = Date.now();
    if (this.dirtyEntries === 0) this.firstDirty = now;
    this.lastDirty = now;
    this.dirtyEntries += entries;
    this.dirtyBytes += bytes;
  }

  batch<T>(fn: () => T): T {
    this.holds++;
    try {
      return fn();
    } finally {
      this.holds--;
      this.settle();
    }
  }

  settle(): void {
    if (this.holds > 0 || this.depth > 0 || this.flushing || this.dirtyEntries === 0) return;
    const behind = this.behind;
    if (!behind || this.dirtyBytes >= behind.maxBytes || this.dirtyEntries >= behind.maxEntries) {
      this.flush();
      return;
    }
    this.schedule(behind.idleMs);
  }

  private schedule(ms: number): void {
    if (this.timer !== undefined) return;
    const timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private tick(): void {
    const behind = this.behind;
    if (!behind || this.dirtyEntries === 0) return;
    const now = Date.now();
    const idle = now - this.lastDirty;
    const age = now - this.firstDirty;
    if (idle < behind.idleMs && age < behind.maxMs) {
      this.schedule(Math.max(1, Math.min(behind.idleMs - idle, behind.maxMs - age)));
      return;
    }
    try {
      this.flush();
    } catch (err) {
      console.warn(`slicc-kernel: flushing the SQLite file system failed, will retry: ${err}`);
      this.schedule(behind.idleMs);
    }
  }

  flush(extra?: () => void): void {
    if ((this.dirtyEntries === 0 && !extra) || this.flushing || this.depth > 0) return;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flushing = true;
    try {
      this.atomically(() => {
        for (const overlay of this.overlays) overlay.flushInto(this);
        extra?.();
      });
      for (const overlay of this.overlays) overlay.flushed();
      this.dirtyEntries = 0;
      this.dirtyBytes = 0;
      this.flushes++;
    } finally {
      this.flushing = false;
    }
  }

  stats(): FlushStats {
    return { flushes: this.flushes, pending: this.dirtyEntries > 0 };
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

  private current(): boolean {
    try {
      const found = this.row("SELECT version FROM slicc_schema WHERE part = 'fs'");
      return found !== undefined && Number(found.version) === SCHEMA_VERSION;
    } catch {
      return false;
    }
  }

  private migrate(): void {
    if (this.current()) return;
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
    known.configure(options);
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

export function sqliteFlush(sql: SqlStorageLike): FlushStats {
  const store = stores.get(sql);
  if (!store) return { flushes: 0, pending: false };
  store.flush();
  return store.stats();
}
