import {
  bytesOf,
  decodeText,
  encodeText,
  type SqliteOptions,
  type SqlStorageLike,
  type SqlStore,
  storeOf,
} from './sqlite-store.ts';

export type { SqlCursorLike, SqliteOptions, SqlStorageLike } from './sqlite-store.ts';

export const CHUNK_BYTES = 256 * 1024;

const ROOT_ID = 1;
const NO_CUT = Number.MAX_SAFE_INTEGER;

const fail = (name: string, message: string = name): never => {
  throw new DOMException(message, name);
};

function valid(name: string): void {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/')
  ) {
    throw new TypeError(`invalid name: ${name}`);
  }
}

interface NodeRow {
  id: number;
  parent: number | null;
  name: string;
  dir: boolean;
  size: number;
  modified: number;
  version: number;
}

interface Writer {
  id: number;
  node: number;
  size: number;
  visible: number;
  staged: Set<number>;
}

function nodeOf(row: Record<string, unknown>): NodeRow {
  return {
    id: Number(row.id),
    parent: row.parent === null || row.parent === undefined ? null : Number(row.parent),
    name: decodeText(row.name),
    dir: Number(row.dir) === 1,
    size: Number(row.size),
    modified: Number(row.modified),
    version: Number(row.version),
  };
}

const NODE_COLUMNS = 'id, parent, name, dir, size, modified, version';

class Files {
  readonly store: SqlStore;
  private readonly writers = new Map<number, Writer>();
  private nextWriter = 1;

  constructor(store: SqlStore) {
    this.store = store;
    store.atomically(() => {
      store.run(
        'INSERT OR IGNORE INTO slicc_nodes (id, parent, name, dir, size, modified) VALUES (?, NULL, ?, 1, 0, ?)',
        ROOT_ID,
        new Uint8Array(0),
        Date.now()
      );
      store.run('DELETE FROM slicc_staged');
    });
  }

  node(id: number): NodeRow | undefined {
    const row = this.store.row(`SELECT ${NODE_COLUMNS} FROM slicc_nodes WHERE id = ?`, id);
    return row && nodeOf(row);
  }

  child(parent: number, name: string): NodeRow | undefined {
    const row = this.store.row(
      `SELECT ${NODE_COLUMNS} FROM slicc_nodes WHERE parent = ? AND name = ?`,
      parent,
      encodeText(name)
    );
    return row && nodeOf(row);
  }

  children(parent: number): NodeRow[] {
    return this.store
      .rows(`SELECT ${NODE_COLUMNS} FROM slicc_nodes WHERE parent = ? ORDER BY id`, parent)
      .map(nodeOf);
  }

  hasChildren(id: number): boolean {
    return (
      this.store.row('SELECT 1 AS found FROM slicc_nodes WHERE parent = ? LIMIT 1', id) !==
      undefined
    );
  }

  create(parent: number, name: string, dir: boolean): number {
    const row = this.store.row(
      'INSERT INTO slicc_nodes (parent, name, dir, size, modified) VALUES (?, ?, ?, 0, ?) RETURNING id',
      parent,
      encodeText(name),
      dir ? 1 : 0,
      Date.now()
    );
    return Number(row?.id);
  }

  removeTree(id: number): void {
    const tree =
      'WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT n.id FROM slicc_nodes n JOIN tree t ON n.parent = t.id)';
    this.store.atomically(() => {
      this.store.run(`${tree} DELETE FROM slicc_chunks WHERE node IN (SELECT id FROM tree)`, id);
      this.store.run(`${tree} DELETE FROM slicc_nodes WHERE id IN (SELECT id FROM tree)`, id);
    });
  }

  place(id: number, parent: number, name: string): void {
    this.store.run(
      'UPDATE slicc_nodes SET parent = ?, name = ? WHERE id = ?',
      parent,
      encodeText(name),
      id
    );
  }

  within(id: number, ancestor: number): boolean {
    for (let at: number | null = id; at !== null; ) {
      if (at === ancestor) return true;
      at = this.node(at)?.parent ?? null;
    }
    return false;
  }

  read(node: number, version: number, start: number, end: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, end - start));
    if (out.length === 0) return this.checked(node, version, out);
    const first = Math.floor(start / CHUNK_BYTES);
    const last = Math.floor((end - 1) / CHUNK_BYTES);
    const rows = this.store.rows(
      `SELECT idx, substr(data, max(? - idx * ${CHUNK_BYTES}, 0) + 1, min(? - idx * ${CHUNK_BYTES}, ${CHUNK_BYTES}) - max(? - idx * ${CHUNK_BYTES}, 0)) AS part FROM slicc_chunks WHERE node = ? AND idx BETWEEN ? AND ?`,
      start,
      end,
      start,
      node,
      first,
      last
    );
    for (const row of rows) {
      const at = Number(row.idx) * CHUNK_BYTES;
      out.set(bytesOf(row.part), Math.max(at, start) - start);
    }
    return this.checked(node, version, out);
  }

  private checked(node: number, version: number, out: Uint8Array): Uint8Array {
    const found = this.node(node);
    if (!found) return fail('NotFoundError', 'the file was removed after it was read');
    if (found.version !== version) {
      return fail('NotReadableError', 'the file changed after it was read');
    }
    return out;
  }

  private writer(id: number): Writer {
    const writer = this.writers.get(id);
    if (!writer) return fail('InvalidStateError', 'the writable was closed');
    return writer;
  }

  open(node: number, keep: boolean): number {
    const found = this.node(node);
    if (!found || found.dir) return fail('NotFoundError');
    const size = keep ? found.size : 0;
    const id = this.nextWriter++;
    this.writers.set(id, { id, node, size, visible: size, staged: new Set() });
    return id;
  }

  private view(writer: Writer, idx: number): Uint8Array {
    if (writer.staged.has(idx)) {
      const staged = this.store.row(
        'SELECT data FROM slicc_staged WHERE writer = ? AND idx = ?',
        writer.id,
        idx
      );
      return bytesOf(staged?.data);
    }
    const keep = Math.min(CHUNK_BYTES, writer.visible - idx * CHUNK_BYTES);
    if (keep <= 0) return new Uint8Array(0);
    const base = this.store.row(
      'SELECT substr(data, 1, ?) AS data FROM slicc_chunks WHERE node = ? AND idx = ?',
      keep,
      writer.node,
      idx
    );
    return bytesOf(base?.data);
  }

  write(id: number, at: number, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const writer = this.writer(id);
    const staged: number[] = [];
    this.store.atomically(() => {
      for (let done = 0; done < bytes.length; ) {
        const idx = Math.floor((at + done) / CHUNK_BYTES);
        const from = at + done - idx * CHUNK_BYTES;
        const n = Math.min(CHUNK_BYTES - from, bytes.length - done);
        const part = bytes.subarray(done, done + n);
        let data = part;
        if (from !== 0 || n !== CHUNK_BYTES) {
          const old = this.view(writer, idx);
          if (from !== 0 || old.length > n) {
            data = new Uint8Array(Math.max(old.length, from + n));
            data.set(old.subarray(0, Math.min(old.length, data.length)));
            data.set(part, from);
          }
        }
        this.store.run(
          'INSERT OR REPLACE INTO slicc_staged (writer, idx, data) VALUES (?, ?, ?)',
          id,
          idx,
          data
        );
        staged.push(idx);
        done += n;
      }
    });
    for (const idx of staged) writer.staged.add(idx);
    writer.size = Math.max(writer.size, at + bytes.length);
  }

  truncate(id: number, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError(`invalid size: ${size}`);
    const writer = this.writer(id);
    const kept = Math.ceil(size / CHUNK_BYTES);
    if (size < writer.size) {
      this.store.atomically(() => {
        this.store.run('DELETE FROM slicc_staged WHERE writer = ? AND idx >= ?', id, kept);
        const tail = size % CHUNK_BYTES;
        if (tail !== 0) {
          this.store.run(
            'UPDATE slicc_staged SET data = substr(data, 1, ?) WHERE writer = ? AND idx = ? AND length(data) > ?',
            tail,
            id,
            Math.floor(size / CHUNK_BYTES),
            tail
          );
        }
      });
      for (const idx of [...writer.staged]) if (idx >= kept) writer.staged.delete(idx);
    }
    writer.size = size;
    writer.visible = Math.min(writer.visible, size);
  }

  commit(id: number): void {
    const writer = this.writer(id);
    const preserved = this.store.atomically(() => {
      const node = this.node(writer.node);
      const landed = node && !node.dir ? this.land(writer, node) : [];
      this.store.run('DELETE FROM slicc_staged WHERE writer = ?', id);
      return landed;
    });
    this.writers.delete(id);
    for (const [other, idx] of preserved) other.staged.add(idx);
  }

  private land(writer: Writer, node: NodeRow): Array<[Writer, number]> {
    const cut = writer.visible < node.size ? writer.visible : undefined;
    const cutIdx = cut === undefined ? NO_CUT : Math.floor(cut / CHUNK_BYTES);
    const preserved: Array<[Writer, number]> = [];
    for (const other of this.writers.values()) {
      if (other === writer || other.node !== node.id || other.visible <= 0) continue;
      for (const idx of this.preserve(other, writer.staged, cutIdx)) preserved.push([other, idx]);
    }
    if (cut !== undefined) {
      this.store.run(
        'DELETE FROM slicc_chunks WHERE node = ? AND idx >= ?',
        node.id,
        Math.ceil(cut / CHUNK_BYTES)
      );
      const tail = cut % CHUNK_BYTES;
      if (tail !== 0) {
        this.store.run(
          'UPDATE slicc_chunks SET data = substr(data, 1, ?) WHERE node = ? AND idx = ? AND length(data) > ?',
          tail,
          node.id,
          cutIdx,
          tail
        );
      }
    }
    if (writer.staged.size > 0) {
      this.store.run(
        'DELETE FROM slicc_chunks WHERE node = ? AND idx IN (SELECT idx FROM slicc_staged WHERE writer = ? AND length(data) = 0)',
        node.id,
        writer.id
      );
      this.store.run(
        'INSERT OR REPLACE INTO slicc_chunks (node, idx, data) SELECT ?, idx, data FROM slicc_staged WHERE writer = ? AND length(data) > 0',
        node.id,
        writer.id
      );
    }
    this.store.run(
      'UPDATE slicc_nodes SET size = ?, modified = ?, version = version + 1 WHERE id = ?',
      writer.size,
      Date.now(),
      node.id
    );
    return preserved;
  }

  private preserve(other: Writer, staged: ReadonlySet<number>, cutIdx: number): number[] {
    const limit = Math.ceil(other.visible / CHUNK_BYTES);
    const touched = new Set([...staged].filter((idx) => idx < limit));
    for (let idx = cutIdx; idx < limit; idx++) touched.add(idx);
    const kept: number[] = [];
    for (const idx of touched) {
      if (other.staged.has(idx)) continue;
      const keep = Math.min(CHUNK_BYTES, other.visible - idx * CHUNK_BYTES);
      const copied = this.store.run(
        'INSERT INTO slicc_staged (writer, idx, data) SELECT ?, idx, substr(data, 1, ?) FROM slicc_chunks WHERE node = ? AND idx = ?',
        other.id,
        keep,
        other.node,
        idx
      );
      if (copied === 0) {
        this.store.run(
          "INSERT INTO slicc_staged (writer, idx, data) VALUES (?, ?, x'')",
          other.id,
          idx
        );
      }
      kept.push(idx);
    }
    return kept;
  }

  discard(id: number): void {
    if (!this.writers.delete(id)) return;
    this.store.run('DELETE FROM slicc_staged WHERE writer = ?', id);
  }
}

const engines = new WeakMap<SqlStore, Files>();

function filesOf(store: SqlStore): Files {
  let files = engines.get(store);
  if (!files) engines.set(store, (files = new Files(store)));
  return files;
}

class SqliteBlob {
  protected readonly files: Files;
  protected readonly node: number;
  protected readonly version: number;
  protected readonly start: number;
  protected readonly end: number;
  readonly type: string;

  constructor(files: Files, node: number, version: number, start: number, end: number, type = '') {
    this.files = files;
    this.node = node;
    this.version = version;
    this.start = start;
    this.end = end;
    this.type = type;
  }

  get size(): number {
    return this.end - this.start;
  }

  slice(start = 0, end: number = this.size, type = ''): SqliteBlob {
    const size = this.size;
    const from = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
    const to = end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
    return new SqliteBlob(
      this.files,
      this.node,
      this.version,
      this.start + from,
      this.start + Math.max(from, to),
      type
    );
  }

  readBytes(): Uint8Array {
    return this.files.read(this.node, this.version, this.start, this.end);
  }

  sameStore(files: Files): boolean {
    return this.files === files;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.readBytes();
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  }

  async bytes(): Promise<Uint8Array> {
    return this.readBytes();
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.readBytes());
  }

  stream(): ReadableStream<Uint8Array> {
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (at >= this.size) {
          controller.close();
          return;
        }
        const next = Math.min(this.size, at + CHUNK_BYTES);
        controller.enqueue(this.slice(at, next).readBytes());
        at = next;
      },
    });
  }
}

class SqliteFile extends SqliteBlob {
  readonly name: string;
  readonly lastModified: number;
  readonly webkitRelativePath = '';

  constructor(files: Files, row: NodeRow, name: string) {
    super(files, row.id, row.version, 0, row.size);
    this.name = name;
    this.lastModified = row.modified;
  }
}

interface WriteParams {
  type: 'write' | 'seek' | 'truncate';
  data?: unknown;
  position?: number;
  size?: number;
}

const isParams = (data: unknown): data is WriteParams =>
  ['write', 'seek', 'truncate'].includes((data as { type?: unknown } | null)?.type as string) &&
  !(data instanceof SqliteBlob) &&
  !(typeof Blob !== 'undefined' && data instanceof Blob);

function plainBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('slicc-kernel: a writable takes strings, buffers and blobs');
}

type Handle = SqliteFileHandle | SqliteDirectoryHandle;

abstract class SqliteHandle {
  readonly files: Files;
  readonly id: number;
  name: string;

  constructor(files: Files, id: number, name: string) {
    this.files = files;
    this.id = id;
    this.name = name;
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof SqliteHandle && other.files === this.files && other.id === this.id;
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }

  protected destination(
    target: unknown,
    name: unknown
  ): { parent: SqliteDirectoryHandle | undefined; name: string } {
    if (typeof target === 'string') return { parent: undefined, name: target };
    if (!(target instanceof SqliteDirectoryHandle) || target.files !== this.files) {
      return fail('InvalidModificationError', 'the destination is on another file system');
    }
    return { parent: target, name: typeof name === 'string' ? name : this.name };
  }
}

class SqliteFileHandle extends SqliteHandle {
  readonly kind = 'file';

  async getFile(): Promise<File> {
    const row = this.files.node(this.id);
    if (!row || row.dir) return fail('NotFoundError');
    return new SqliteFile(this.files, row, this.name) as unknown as File;
  }

  async createWritable({ keepExistingData = false } = {}) {
    const files = this.files;
    const id = files.open(this.id, keepExistingData);
    let position = 0;
    const put = async (data: unknown) => {
      if (data instanceof SqliteBlob) {
        for (let at = 0; at < data.size; at += CHUNK_BYTES) {
          const part = data.slice(at, at + CHUNK_BYTES).readBytes();
          files.write(id, position, part);
          position += part.length;
        }
        return;
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        for (let at = 0; at < data.size; at += CHUNK_BYTES) {
          const part = new Uint8Array(await data.slice(at, at + CHUNK_BYTES).arrayBuffer());
          files.write(id, position, part);
          position += part.length;
        }
        return;
      }
      const bytes = plainBytes(data);
      files.write(id, position, bytes);
      position += bytes.length;
    };
    return {
      write: async (data: unknown) => {
        if (!isParams(data)) return put(data);
        if (data.type === 'truncate') return files.truncate(id, data.size ?? 0);
        position = data.position ?? position;
        if (data.type === 'write') await put(data.data);
      },
      seek: async (at: number) => {
        position = at;
      },
      truncate: async (size: number) => files.truncate(id, size),
      close: async () => files.commit(id),
      abort: async () => files.discard(id),
    };
  }

  async move(target: unknown, name?: unknown): Promise<void> {
    const where = this.destination(target, name);
    valid(where.name);
    const files = this.files;
    files.store.atomically(() => {
      const self = files.node(this.id);
      if (!self) return fail('NotFoundError');
      const parent = where.parent ? files.node(where.parent.id) : files.node(self.parent ?? -1);
      if (!parent?.dir) return fail('NotFoundError');
      const taken = files.child(parent.id, where.name);
      if (taken?.dir) return fail('InvalidModificationError');
      if (taken && taken.id !== this.id) files.removeTree(taken.id);
      files.place(this.id, parent.id, where.name);
    });
    this.name = where.name;
  }
}

class SqliteDirectoryHandle extends SqliteHandle {
  readonly kind = 'directory';

  private present(): NodeRow {
    const row = this.files.node(this.id);
    if (!row?.dir) return fail('NotFoundError');
    return row;
  }

  async getDirectoryHandle(name: string, { create = false } = {}): Promise<SqliteDirectoryHandle> {
    this.present();
    valid(name);
    const found = this.files.child(this.id, name);
    if (found && !found.dir) return fail('TypeMismatchError');
    if (found) return new SqliteDirectoryHandle(this.files, found.id, name);
    if (!create) return fail('NotFoundError');
    return new SqliteDirectoryHandle(this.files, this.files.create(this.id, name, true), name);
  }

  async getFileHandle(name: string, { create = false } = {}): Promise<SqliteFileHandle> {
    this.present();
    valid(name);
    const found = this.files.child(this.id, name);
    if (found?.dir) return fail('TypeMismatchError');
    if (found) return new SqliteFileHandle(this.files, found.id, name);
    if (!create) return fail('NotFoundError');
    return new SqliteFileHandle(this.files, this.files.create(this.id, name, false), name);
  }

  async removeEntry(name: string, { recursive = false } = {}): Promise<void> {
    this.present();
    valid(name);
    const files = this.files;
    files.store.atomically(() => {
      const found = files.child(this.id, name);
      if (!found) return fail('NotFoundError');
      if (found.dir && !recursive && files.hasChildren(found.id)) {
        return fail('InvalidModificationError');
      }
      files.removeTree(found.id);
    });
  }

  async resolve(handle: unknown): Promise<string[] | null> {
    if (!(handle instanceof SqliteHandle) || handle.files !== this.files) return null;
    const names: string[] = [];
    for (let at = handle.id; at !== this.id; ) {
      const row = this.files.node(at);
      if (!row || row.parent === null) return null;
      names.unshift(row.name);
      at = row.parent;
    }
    return names;
  }

  private handleOf(row: NodeRow): Handle {
    return row.dir
      ? new SqliteDirectoryHandle(this.files, row.id, row.name)
      : new SqliteFileHandle(this.files, row.id, row.name);
  }

  async *keys(): AsyncGenerator<string> {
    this.present();
    for (const row of this.files.children(this.id)) yield row.name;
  }

  async *values(): AsyncGenerator<Handle> {
    for (const row of this.files.children(this.id)) yield this.handleOf(row);
  }

  async *entries(): AsyncGenerator<[string, Handle]> {
    for (const row of this.files.children(this.id)) yield [row.name, this.handleOf(row)];
  }

  [Symbol.asyncIterator](): AsyncGenerator<[string, Handle]> {
    return this.entries();
  }

  async move(target: unknown, name?: unknown): Promise<void> {
    const where = this.destination(target, name);
    valid(where.name);
    const files = this.files;
    files.store.atomically(() => {
      const self = files.node(this.id);
      if (!self?.dir || self.parent === null) return fail('NotFoundError');
      const parent = where.parent ? files.node(where.parent.id) : files.node(self.parent);
      if (!parent?.dir) return fail('NotFoundError');
      if (files.within(parent.id, this.id)) return fail('InvalidModificationError');
      const taken = files.child(parent.id, where.name);
      if (taken && taken.id !== this.id) return fail('InvalidModificationError');
      files.place(this.id, parent.id, where.name);
    });
    this.name = where.name;
  }
}

export function sqliteRoot(
  sql: SqlStorageLike,
  options: SqliteOptions = {}
): FileSystemDirectoryHandle {
  const files = filesOf(storeOf(sql, options));
  return new SqliteDirectoryHandle(files, ROOT_ID, '') as unknown as FileSystemDirectoryHandle;
}

export function isSqliteRoot(handle: FileSystemDirectoryHandle): boolean {
  return (handle as unknown) instanceof SqliteDirectoryHandle;
}
