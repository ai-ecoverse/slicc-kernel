import {
  bytesOf,
  decodeText,
  encodeText,
  type Overlay,
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
  staged: Map<number, Uint8Array>;
  spilled: Set<number>;
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

interface Chunks {
  cut: number;
  data: Map<number, Uint8Array | null>;
}

const STAGED_BYTES = 4 * 1024 * 1024;

function childKey(parent: number, name: string): string {
  return `${parent}/${name}`;
}

class Files implements Overlay {
  readonly store: SqlStore;
  private readonly writers = new Map<number, Writer>();
  private nextWriter = 1;
  private nextNode: number;
  private readonly nodes = new Map<number, NodeRow | null>();
  private readonly named = new Map<string, number>();
  private readonly under = new Map<number, Set<number>>();
  private readonly chunks = new Map<number, Chunks>();
  private stagedBytes = 0;

  constructor(store: SqlStore) {
    this.store = store;
    if (!store.row('SELECT id FROM slicc_nodes WHERE id = ?', ROOT_ID)) {
      store.run(
        'INSERT OR IGNORE INTO slicc_nodes (id, parent, name, dir, size, modified) VALUES (?, NULL, ?, 1, 0, ?)',
        ROOT_ID,
        new Uint8Array(0),
        Date.now()
      );
    }
    if (store.row('SELECT writer FROM slicc_staged LIMIT 1')) store.run('DELETE FROM slicc_staged');
    this.nextNode = Number(store.row('SELECT max(id) AS top FROM slicc_nodes')?.top ?? ROOT_ID) + 1;
    store.register(this);
  }

  private stored(id: number): NodeRow | undefined {
    const row = this.store.row(`SELECT ${NODE_COLUMNS} FROM slicc_nodes WHERE id = ?`, id);
    return row && nodeOf(row);
  }

  node(id: number): NodeRow | undefined {
    const dirty = this.nodes.get(id);
    if (dirty !== undefined) return dirty ?? undefined;
    return this.stored(id);
  }

  child(parent: number, name: string): NodeRow | undefined {
    const dirty = this.named.get(childKey(parent, name));
    if (dirty !== undefined) return this.nodes.get(dirty) ?? undefined;
    const row = this.store.row(
      `SELECT ${NODE_COLUMNS} FROM slicc_nodes WHERE parent = ? AND name = ?`,
      parent,
      encodeText(name)
    );
    if (!row) return undefined;
    const found = nodeOf(row);
    return this.nodes.has(found.id) ? undefined : found;
  }

  children(parent: number): NodeRow[] {
    const stored = this.store
      .rows(`SELECT ${NODE_COLUMNS} FROM slicc_nodes WHERE parent = ? ORDER BY id`, parent)
      .map(nodeOf)
      .filter((row) => !this.nodes.has(row.id));
    const dirty = this.under.get(parent);
    if (!dirty || dirty.size === 0) return stored;
    for (const id of dirty) stored.push(this.nodes.get(id) as NodeRow);
    return stored.sort((a, b) => a.id - b.id);
  }

  hasChildren(id: number): boolean {
    if ((this.under.get(id)?.size ?? 0) > 0) return true;
    return this.store
      .rows('SELECT id FROM slicc_nodes WHERE parent = ?', id)
      .some((row) => !this.nodes.has(Number(row.id)));
  }

  private unlink(row: NodeRow): void {
    if (row.parent === null) return;
    const key = childKey(row.parent, row.name);
    if (this.named.get(key) === row.id) this.named.delete(key);
    this.under.get(row.parent)?.delete(row.id);
  }

  private put(row: NodeRow | null, id: number): void {
    const old = this.nodes.get(id);
    if (old) this.unlink(old);
    if (old === undefined) this.store.changed(1, 64);
    this.nodes.set(id, row);
    if (!row || row.parent === null) return;
    this.named.set(childKey(row.parent, row.name), id);
    let set = this.under.get(row.parent);
    if (!set) this.under.set(row.parent, (set = new Set()));
    set.add(id);
  }

  private update(id: number, change: Partial<NodeRow>): void {
    const row = this.node(id);
    if (row) this.put({ ...row, ...change }, id);
  }

  create(parent: number, name: string, dir: boolean): number {
    const id = this.nextNode++;
    this.put({ id, parent, name, dir, size: 0, modified: Date.now(), version: 0 }, id);
    this.store.settle();
    return id;
  }

  removeTree(id: number): void {
    const doomed = [id];
    for (let i = 0; i < doomed.length; i++) {
      for (const child of this.children(doomed[i] as number)) doomed.push(child.id);
    }
    for (const gone of doomed) {
      this.put(null, gone);
      this.dropChunks(gone);
    }
    this.store.settle();
  }

  place(id: number, parent: number, name: string): void {
    this.update(id, { parent, name });
    this.store.settle();
  }

  within(id: number, ancestor: number): boolean {
    for (let at: number | null = id; at !== null; ) {
      if (at === ancestor) return true;
      at = this.node(at)?.parent ?? null;
    }
    return false;
  }

  private chunkState(node: number): Chunks {
    let state = this.chunks.get(node);
    if (!state) this.chunks.set(node, (state = { cut: NO_CUT, data: new Map() }));
    return state;
  }

  private setChunk(node: number, idx: number, data: Uint8Array | null): void {
    const state = this.chunkState(node);
    const old = state.data.get(idx);
    this.store.changed(old === undefined ? 1 : 0, (data?.length ?? 0) - (old?.length ?? 0));
    state.data.set(idx, data);
  }

  private dropChunks(node: number): void {
    const state = this.chunkState(node);
    for (const old of state.data.values()) this.store.changed(0, -(old?.length ?? 0));
    state.data.clear();
    state.cut = 0;
    this.store.changed(1, 0);
  }

  private cutChunks(node: number, from: number): void {
    const state = this.chunkState(node);
    for (const [idx, old] of [...state.data]) {
      if (idx < from) continue;
      state.data.delete(idx);
      this.store.changed(0, -(old?.length ?? 0));
    }
    if (from < state.cut) {
      state.cut = from;
      this.store.changed(1, 0);
    }
  }

  private chunkPart(node: number, idx: number, from: number, to: number): Uint8Array | undefined {
    const state = this.chunks.get(node);
    const dirty = state?.data.get(idx);
    if (dirty !== undefined) return dirty === null ? undefined : dirty.subarray(from, to);
    if (state && idx >= state.cut) return undefined;
    const row = this.store.row(
      'SELECT substr(data, ?, ?) AS part FROM slicc_chunks WHERE node = ? AND idx = ?',
      from + 1,
      to - from,
      node,
      idx
    );
    return row ? bytesOf(row.part) : undefined;
  }

  read(node: number, version: number, start: number, end: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, end - start));
    if (out.length === 0) return this.checked(node, version, out);
    const first = Math.floor(start / CHUNK_BYTES);
    const last = Math.floor((end - 1) / CHUNK_BYTES);
    const state = this.chunks.get(node);
    const rows = this.store.rows(
      `SELECT idx, substr(data, max(? - idx * ${CHUNK_BYTES}, 0) + 1, min(? - idx * ${CHUNK_BYTES}, ${CHUNK_BYTES}) - max(? - idx * ${CHUNK_BYTES}, 0)) AS part FROM slicc_chunks WHERE node = ? AND idx BETWEEN ? AND ?`,
      start,
      end,
      start,
      node,
      first,
      Math.min(last, (state?.cut ?? NO_CUT) - 1)
    );
    for (const row of rows) {
      const idx = Number(row.idx);
      if (state?.data.has(idx)) continue;
      out.set(bytesOf(row.part), Math.max(idx * CHUNK_BYTES, start) - start);
    }
    if (state) {
      for (const [idx, data] of state.data) {
        if (idx < first || idx > last || !data) continue;
        const at = idx * CHUNK_BYTES;
        const from = Math.max(start - at, 0);
        const to = Math.min(end - at, data.length);
        if (to > from) out.set(data.subarray(from, to), at + from - start);
      }
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
    this.writers.set(id, { id, node, size, visible: size, staged: new Map(), spilled: new Set() });
    return id;
  }

  private stagedChunk(writer: Writer, idx: number): Uint8Array | undefined {
    const held = writer.staged.get(idx);
    if (held) return held;
    if (!writer.spilled.has(idx)) return undefined;
    const row = this.store.row(
      'SELECT data FROM slicc_staged WHERE writer = ? AND idx = ?',
      writer.id,
      idx
    );
    return bytesOf(row?.data);
  }

  private view(writer: Writer, idx: number): Uint8Array {
    const staged = this.stagedChunk(writer, idx);
    if (staged) return staged;
    const keep = Math.min(CHUNK_BYTES, writer.visible - idx * CHUNK_BYTES);
    if (keep <= 0) return new Uint8Array(0);
    return this.chunkPart(writer.node, idx, 0, keep) ?? new Uint8Array(0);
  }

  private stage(writer: Writer, idx: number, data: Uint8Array): void {
    const old = writer.staged.get(idx);
    this.stagedBytes += data.length - (old?.length ?? 0);
    writer.staged.set(idx, data);
    writer.spilled.delete(idx);
  }

  private unstage(writer: Writer, idx: number): void {
    const old = writer.staged.get(idx);
    if (old) this.stagedBytes -= old.length;
    writer.staged.delete(idx);
    writer.spilled.delete(idx);
  }

  private spill(): void {
    if (this.stagedBytes < STAGED_BYTES) return;
    const writers = [...this.writers.values()].filter((w) => w.staged.size > 0);
    this.store.atomically(() => {
      for (const writer of writers) {
        for (const [idx, data] of writer.staged) {
          this.store.run(
            'INSERT OR REPLACE INTO slicc_staged (writer, idx, data) VALUES (?, ?, ?)',
            writer.id,
            idx,
            data
          );
        }
      }
    });
    for (const writer of writers) {
      for (const [idx, data] of writer.staged) {
        this.stagedBytes -= data.length;
        writer.spilled.add(idx);
      }
      writer.staged.clear();
    }
  }

  write(id: number, at: number, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const writer = this.writer(id);
    for (let done = 0; done < bytes.length; ) {
      const idx = Math.floor((at + done) / CHUNK_BYTES);
      const from = at + done - idx * CHUNK_BYTES;
      const n = Math.min(CHUNK_BYTES - from, bytes.length - done);
      const part = bytes.subarray(done, done + n);
      const old = from !== 0 || n !== CHUNK_BYTES ? this.view(writer, idx) : undefined;
      const data = new Uint8Array(Math.max(old?.length ?? 0, from + n));
      if (old) data.set(old.subarray(0, Math.min(old.length, data.length)));
      data.set(part, from);
      this.stage(writer, idx, data);
      done += n;
    }
    writer.size = Math.max(writer.size, at + bytes.length);
    this.spill();
  }

  truncate(id: number, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError(`invalid size: ${size}`);
    const writer = this.writer(id);
    const kept = Math.ceil(size / CHUNK_BYTES);
    if (size < writer.size) {
      for (const idx of [...writer.staged.keys(), ...writer.spilled]) {
        if (idx >= kept) this.unstage(writer, idx);
      }
      const tail = size % CHUNK_BYTES;
      const last = Math.floor(size / CHUNK_BYTES);
      if (tail !== 0) {
        const held = this.stagedChunk(writer, last);
        if (held && held.length > tail) this.stage(writer, last, held.slice(0, tail));
      }
    }
    writer.size = size;
    writer.visible = Math.min(writer.visible, size);
  }

  commit(id: number): void {
    const writer = this.writer(id);
    const node = this.node(writer.node);
    if (node && !node.dir) this.land(writer, node);
    this.discard(id);
    this.store.settle();
  }

  private land(writer: Writer, node: NodeRow): void {
    const cut = writer.visible < node.size ? writer.visible : undefined;
    const cutIdx = cut === undefined ? NO_CUT : Math.floor(cut / CHUNK_BYTES);
    const touched = new Set([...writer.staged.keys(), ...writer.spilled]);
    for (const other of this.writers.values()) {
      if (other === writer || other.node !== node.id || other.visible <= 0) continue;
      this.preserve(other, touched, cutIdx);
    }
    if (cut !== undefined) {
      const tail = cut % CHUNK_BYTES;
      const part = tail === 0 ? undefined : this.chunkPart(node.id, cutIdx, 0, tail);
      this.cutChunks(node.id, Math.ceil(cut / CHUNK_BYTES));
      if (part) this.setChunk(node.id, cutIdx, part.slice());
    }
    for (const [idx, data] of writer.staged)
      this.setChunk(node.id, idx, data.length > 0 ? data : null);
    this.stagedBytes -= [...writer.staged.values()].reduce((sum, data) => sum + data.length, 0);
    writer.staged.clear();
    this.update(node.id, { size: writer.size, modified: Date.now(), version: node.version + 1 });
    if (writer.spilled.size > 0) this.landSpilled(writer, node.id);
  }

  private landSpilled(writer: Writer, node: number): void {
    const spilled = [...writer.spilled];
    for (const idx of spilled) this.chunkState(node).data.delete(idx);
    this.store.changed(1, 0);
    this.store.flush(() => {
      this.store.run(
        'DELETE FROM slicc_chunks WHERE node = ? AND idx IN (SELECT idx FROM slicc_staged WHERE writer = ? AND length(data) = 0)',
        node,
        writer.id
      );
      this.store.run(
        'INSERT OR REPLACE INTO slicc_chunks (node, idx, data) SELECT ?, idx, data FROM slicc_staged WHERE writer = ? AND length(data) > 0',
        node,
        writer.id
      );
      this.store.run('DELETE FROM slicc_staged WHERE writer = ?', writer.id);
    });
    writer.spilled.clear();
  }

  private preserve(other: Writer, touched: ReadonlySet<number>, cutIdx: number): void {
    const limit = Math.ceil(other.visible / CHUNK_BYTES);
    const copy = new Set([...touched].filter((idx) => idx < limit));
    for (let idx = cutIdx; idx < limit; idx++) copy.add(idx);
    for (const idx of copy) {
      if (other.staged.has(idx) || other.spilled.has(idx)) continue;
      const keep = Math.min(CHUNK_BYTES, other.visible - idx * CHUNK_BYTES);
      this.stage(
        other,
        idx,
        this.chunkPart(other.node, idx, 0, keep)?.slice() ?? new Uint8Array(0)
      );
    }
  }

  discard(id: number): void {
    const writer = this.writers.get(id);
    if (!writer) return;
    for (const idx of [...writer.staged.keys()]) this.unstage(writer, idx);
    this.writers.delete(id);
    if (writer.spilled.size > 0) this.store.run('DELETE FROM slicc_staged WHERE writer = ?', id);
  }

  flushInto(store: SqlStore): void {
    for (const [id, state] of this.chunks) {
      const row = this.nodes.get(id);
      if (row === null || state.cut === 0) {
        store.run('DELETE FROM slicc_chunks WHERE node = ?', id);
      } else if (state.cut !== NO_CUT) {
        store.run('DELETE FROM slicc_chunks WHERE node = ? AND idx >= ?', id, state.cut);
      }
      if (row === null) continue;
      for (const [idx, data] of state.data) {
        if (data) {
          store.run(
            'INSERT OR REPLACE INTO slicc_chunks (node, idx, data) VALUES (?, ?, ?)',
            id,
            idx,
            data
          );
        } else {
          store.run('DELETE FROM slicc_chunks WHERE node = ? AND idx = ?', id, idx);
        }
      }
    }
    for (const [id, row] of this.nodes) {
      if (!row) {
        store.run('DELETE FROM slicc_nodes WHERE id = ?', id);
        continue;
      }
      store.run(
        'INSERT OR REPLACE INTO slicc_nodes (id, parent, name, dir, size, modified, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        row.parent,
        encodeText(row.name),
        row.dir ? 1 : 0,
        row.size,
        row.modified,
        row.version
      );
    }
  }

  flushed(): void {
    this.nodes.clear();
    this.named.clear();
    this.under.clear();
    this.chunks.clear();
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
    files.store.batch(() => {
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
    files.store.batch(() => {
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
    files.store.batch(() => {
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
