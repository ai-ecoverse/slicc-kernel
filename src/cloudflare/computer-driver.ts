import {
  type DriverSetAttr,
  type FilesystemHandlers,
  fsError,
  type OpenFlags,
  type ServedFilesystem,
} from '../mount/driver.ts';
import type { DriverAttr, DriverCapabilities, DriverEntry } from '../mount/protocol.ts';

export interface WorkspaceStatLike {
  inode?: number;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface WorkspaceDirentLike {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface WorkspaceFilesystemLike {
  readFile(
    path: string,
    options: { byteOffset?: number; byteLength?: number }
  ): Promise<ReadableStream<Uint8Array> | string>;
  writeFile(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    options?: { mode?: number; exclusive?: boolean }
  ): Promise<void>;
  stat(path: string): Promise<WorkspaceStatLike>;
  lstat(path: string): Promise<WorkspaceStatLike>;
  readdir(path: string): Promise<WorkspaceDirentLike[]>;
  readlink(path: string): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  link?(existing: string, path: string): Promise<void>;
}

export interface WorkspaceDriverOptions {
  root?: string;
  maxIo?: number;
  bufferBytes?: number;
  attrTtl?: number;
  writeBehind?: boolean | Partial<WriteBehind>;
}

export interface WriteBehind {
  idleMs: number;
  maxMs: number;
  maxEntries: number;
  maxBytes: number;
}

const WRITE_BEHIND: WriteBehind = {
  idleMs: 50,
  maxMs: 1000,
  maxEntries: 256,
  maxBytes: 8 * 1024 * 1024,
};

function writeBehindOf(option: WorkspaceDriverOptions['writeBehind']): WriteBehind | undefined {
  if (!option) return undefined;
  return option === true ? WRITE_BEHIND : { ...WRITE_BEHIND, ...option };
}

function unrefTimer<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

export interface WorkspaceDriver extends FilesystemHandlers {
  readonly capabilities: DriverCapabilities;
  settled(): Promise<void>;
  flush(open?: boolean): Promise<void>;
  pending(): boolean;
  served(served: ServedFilesystem): void;
  invalidate(paths?: string[]): void;
}

const MAX_IO = 1024 * 1024;
const ATTR_TTL = 1000;
const BUFFER_BYTES = 1024 * 1024;
const FILL_STEP = 512 * 1024;
const TYPE_BITS = { file: 0o100000, directory: 0o40000, symlink: 0o120000, fifo: 0o10000 };

const kindOf = (st: WorkspaceStatLike | WorkspaceDirentLike): DriverAttr['kind'] =>
  st.isDirectory ? 'directory' : st.isSymbolicLink ? 'symlink' : 'file';

const codeOf = (err: unknown) => (err as { code?: unknown } | null)?.code;

function attrOf(st: WorkspaceStatLike): DriverAttr {
  const kind = kindOf(st);
  const perms = kind === 'symlink' ? 0o777 : st.mode & 0o7777;
  return {
    kind,
    size: st.size,
    mtime: st.mtime,
    mode: TYPE_BITS[kind] | perms,
    ...(st.inode ? { ino: st.inode } : {}),
  };
}

function translated(err: unknown): unknown {
  const code = codeOf(err);
  if (typeof code !== 'string' || /^E[A-Z]+$/.test(code) === false || code === 'EUNKNOWN_HASH') {
    return fsError('EIO', err instanceof Error ? err.message : String(err));
  }
  return err;
}

async function collect(
  source: ReadableStream<Uint8Array> | string,
  limit: number
): Promise<Uint8Array> {
  if (typeof source === 'string') return new TextEncoder().encode(source).slice(0, limit);
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = source.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const part of parts) {
    if (at >= out.length) break;
    const take = Math.min(part.byteLength, out.length - at);
    out.set(part.subarray(0, take), at);
    at += take;
  }
  return out;
}

interface Handle {
  path: string;
  write: boolean;
  drafting: boolean;
}

class Draft {
  readonly path: string;
  mode: number;
  modeChanged = false;
  size: number;
  private limit: number;
  private written = 0;
  private readonly fs: WorkspaceFilesystemLike;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly committed: Promise<void>;
  private failure: unknown;
  private wake: (() => void) | undefined;

  readonly created: boolean;

  constructor(
    fs: WorkspaceFilesystemLike,
    path: string,
    st: WorkspaceStatLike,
    buffer: number,
    created?: { exclusive: boolean }
  ) {
    this.fs = fs;
    this.created = created !== undefined;
    this.path = path;
    this.mode = st.mode & 0o7777;
    this.size = st.size;
    this.limit = st.size;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => this.poke(),
      },
      { highWaterMark: buffer, size: (chunk) => chunk.byteLength }
    );
    this.committed = fs.writeFile(path, stream, {
      mode: this.mode,
      ...(created?.exclusive ? { exclusive: true } : {}),
    });
    this.committed.catch((err: unknown) => {
      this.failure = err;
      this.poke();
    });
  }

  private poke(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private async emit(bytes: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    this.controller.enqueue(bytes);
    this.written += bytes.byteLength;
    while ((this.controller.desiredSize ?? 1) <= 0 && !this.failure) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    if (this.failure) throw this.failure;
  }

  private async fill(to: number): Promise<void> {
    while (this.written < to) {
      if (this.written < this.limit) {
        const end = Math.min(to, this.limit, this.written + FILL_STEP);
        const length = end - this.written;
        const read = await collect(
          await this.fs.readFile(this.path, { byteOffset: this.written, byteLength: length }),
          length
        );
        if (read.byteLength < length) {
          this.limit = this.written + read.byteLength;
          if (read.byteLength > 0) await this.emit(read);
          continue;
        }
        await this.emit(read);
      } else {
        await this.emit(new Uint8Array(Math.min(to - this.written, FILL_STEP)));
      }
    }
  }

  async write(offset: number, bytes: Uint8Array): Promise<boolean> {
    if (offset < this.written) return false;
    await this.fill(offset);
    if (bytes.byteLength > 0) await this.emit(bytes);
    this.size = Math.max(this.size, this.written);
    return true;
  }

  truncate(size: number): boolean {
    if (size < this.written) return false;
    this.size = size;
    this.limit = Math.min(this.limit, size);
    return true;
  }

  async abandon(): Promise<void> {
    if (!this.failure) this.controller.error(fsError('ECANCELED', `${this.path} was removed`));
    await this.committed.catch(() => undefined);
  }

  async finish(): Promise<void> {
    try {
      await this.fill(this.size);
      this.controller.close();
    } catch (err) {
      if (!this.failure) this.controller.error(err);
      await this.committed.catch(() => undefined);
      throw err;
    }
    await this.committed;
    if (this.modeChanged) await this.fs.chmod(this.path, this.mode);
  }
}

class DriverState {
  readonly fs: WorkspaceFilesystemLike;
  readonly root: string;
  readonly buffer: number;
  readonly handles = new Map<number, Handle>();
  readonly drafts = new Map<string, Draft>();
  private readonly closed = new Set<string>();
  private nextFh = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private oldest: ReturnType<typeof setTimeout> | undefined;
  tail: Promise<unknown> = Promise.resolve();
  readonly behind: WriteBehind | undefined;

  constructor(
    fs: WorkspaceFilesystemLike,
    root: string,
    buffer: number,
    behind: WriteBehind | undefined
  ) {
    this.fs = fs;
    this.root = root;
    this.buffer = buffer;
    this.behind = behind;
  }

  private writing(path: string): boolean {
    return [...this.handles.values()].some((o) => o.path === path && o.drafting);
  }

  private stopTimers(): void {
    clearTimeout(this.idle);
    clearTimeout(this.oldest);
    this.idle = undefined;
    this.oldest = undefined;
  }

  async flush(open = false): Promise<void> {
    this.stopTimers();
    const paths = open ? [...this.drafts.keys()] : [...this.closed];
    this.closed.clear();
    let failed: unknown;
    for (const path of paths) {
      if (!open && this.writing(path)) continue;
      await this.finish(path).catch((err: unknown) => {
        failed ??= err;
      });
    }
    if (failed) throw failed;
  }

  private later(path: string, behind: WriteBehind): Promise<void> | undefined {
    this.closed.add(path);
    let bytes = 0;
    for (const at of this.closed) bytes += this.drafts.get(at)?.size ?? 0;
    if (this.closed.size >= behind.maxEntries || bytes >= behind.maxBytes) return this.flush();
    const run = () => {
      void this.serial(() => this.flush()).catch(() => undefined);
    };
    clearTimeout(this.idle);
    this.idle = unrefTimer(setTimeout(run, behind.idleMs));
    this.oldest ??= unrefTimer(setTimeout(run, behind.maxMs));
    return undefined;
  }

  full(path: string): string {
    return path === '/' ? this.root || '/' : `${this.root}${path}`;
  }

  serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run.catch((err: unknown) => {
      throw translated(err);
    });
  }

  async settled(): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const seen = this.tail;
      await seen;
      if (seen === this.tail) return;
    }
  }

  async finish(path: string): Promise<void> {
    this.closed.delete(path);
    const draft = this.drafts.get(path);
    if (!draft) return;
    this.drafts.delete(path);
    await draft.finish();
  }

  async finishUnder(path: string): Promise<void> {
    for (const at of [...this.drafts.keys()]) {
      if (at === path || at.startsWith(`${path}/`)) await this.finish(at);
    }
  }

  async draftFor(path: string): Promise<Draft> {
    const existing = this.drafts.get(path);
    if (existing) return existing;
    const st = await this.fs.stat(path);
    if (st.isDirectory) throw fsError('EISDIR', path);
    const draft = new Draft(this.fs, path, st, this.buffer);
    this.drafts.set(path, draft);
    return draft;
  }

  handle(fh: number): Handle {
    const found = this.handles.get(fh);
    if (!found) throw fsError('EBADF', `handle ${fh}`);
    return found;
  }

  async truncateTo(path: string, size: number): Promise<void> {
    const draft = this.drafts.get(path);
    if (draft?.truncate(size)) return;
    if (draft && size === 0 && !this.writing(path)) {
      this.drafts.delete(path);
      this.closed.delete(path);
      await draft.abandon();
      const st = {
        mode: draft.mode,
        mtime: Date.now(),
        size: 0,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      };
      const fresh = draft.created
        ? new Draft(this.fs, path, st, this.buffer, { exclusive: false })
        : new Draft(
            this.fs,
            path,
            { ...(await this.fs.stat(path)), mode: draft.mode },
            this.buffer
          );
      fresh.truncate(0);
      if (draft.modeChanged) fresh.modeChanged = true;
      this.drafts.set(path, fresh);
      return;
    }
    await this.finish(path);
    const st = await this.fs.stat(path);
    if (st.isDirectory) throw fsError('EISDIR', path);
    if (st.size === size) return;
    if (size === 0) {
      await this.fs.writeFile(path, new Uint8Array(0), { mode: st.mode & 0o7777 });
      return;
    }
    const rewrite = new Draft(this.fs, path, st, this.buffer);
    rewrite.truncate(size);
    await rewrite.finish();
  }

  async getattr(path: string): Promise<DriverAttr> {
    const at = this.full(path);
    const draft = this.drafts.get(at);
    const st = await this.fs.lstat(at).catch((err: unknown) => {
      if (draft?.created && codeOf(err) === 'ENOENT') return undefined;
      throw err;
    });
    if (!st)
      return {
        kind: 'file',
        size: draft?.size ?? 0,
        mtime: Date.now(),
        mode: 0o100000 | (draft?.mode ?? 0o644),
      };
    const attr = attrOf(st);
    return draft ? { ...attr, size: draft.size, mtime: Date.now() } : attr;
  }

  async readdir(path: string): Promise<DriverEntry[]> {
    const at = this.full(path);
    const entries = (await this.fs.readdir(at)).map(
      (entry): DriverEntry => ({ name: entry.name, kind: kindOf(entry) })
    );
    const prefix = at === '/' ? '/' : `${at}/`;
    const names = new Set(entries.map((entry) => entry.name));
    for (const draft of this.drafts.values()) {
      const name = draft.path.slice(prefix.length);
      if (!draft.created || !draft.path.startsWith(prefix) || name.includes('/')) continue;
      if (!names.has(name)) entries.push({ name, kind: 'file' });
    }
    return entries;
  }

  private async parentMustBeDir(at: string, path: string): Promise<void> {
    const parent = at.slice(0, at.lastIndexOf('/')) || '/';
    if (!(await this.fs.stat(parent)).isDirectory) throw fsError('ENOTDIR', path);
  }

  private created(at: string, mode: number, exclusive: boolean): void {
    const st = {
      mode,
      mtime: Date.now(),
      size: 0,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    };
    this.drafts.set(at, new Draft(this.fs, at, st, this.buffer, { exclusive }));
  }

  private async truncatedLater(at: string, st: WorkspaceStatLike): Promise<boolean> {
    const draft = this.drafts.get(at);
    if (draft) return draft.truncate(0);
    if (st.size === 0) return false;
    const fresh = new Draft(this.fs, at, st, this.buffer);
    fresh.truncate(0);
    this.drafts.set(at, fresh);
    return true;
  }

  async open(path: string, flags: OpenFlags): Promise<number> {
    const at = this.full(path);
    const st = this.drafts.get(at)?.created
      ? undefined
      : await this.fs.lstat(at).catch((err: unknown) => {
          if (codeOf(err) === 'ENOENT') return undefined;
          throw err;
        });
    const pending = !st && this.drafts.get(at)?.created === true;
    if ((st || pending) && flags.exclusive) throw fsError('EEXIST', path);
    if (st?.isDirectory && flags.write) throw fsError('EISDIR', path);
    let drafting = false;
    if (pending) {
      drafting = true;
      if (flags.truncate && flags.write) await this.truncateTo(at, 0);
    } else if (!st) {
      if (!flags.create) throw fsError('ENOENT', path);
      await this.parentMustBeDir(at, path);
      this.created(at, (flags.owner?.mode ?? 0o644) & 0o7777, flags.exclusive);
      drafting = true;
    } else if (flags.truncate && flags.write && st.isFile) {
      if (await this.truncatedLater(at, st)) drafting = true;
      else await this.truncateTo(at, 0);
    }
    this.handles.set(++this.nextFh, { path: at, write: flags.write, drafting });
    return this.nextFh;
  }

  async read(fh: number, offset: number, size: number): Promise<Uint8Array> {
    const h = this.handle(fh);
    await this.finish(h.path);
    if (size === 0) return new Uint8Array(0);
    return collect(await this.fs.readFile(h.path, { byteOffset: offset, byteLength: size }), size);
  }

  async write(fh: number, offset: number, bytes: Uint8Array): Promise<void> {
    const h = this.handle(fh);
    if (!h.write) throw fsError('EBADF', `handle ${fh} is read-only`);
    h.drafting = true;
    if (await (await this.draftFor(h.path)).write(offset, bytes)) return;
    await this.finish(h.path);
    if (!(await (await this.draftFor(h.path)).write(offset, bytes))) {
      throw fsError('EIO', `${h.path}: write refused`);
    }
  }

  async release(fh: number): Promise<void> {
    const h = this.handle(fh);
    this.handles.delete(fh);
    if (!h.drafting || this.writing(h.path)) return;
    if (this.behind && this.drafts.has(h.path)) await this.later(h.path, this.behind);
    else await this.finish(h.path);
  }

  async rmdir(path: string): Promise<void> {
    const at = this.full(path);
    const st = await this.fs.lstat(at);
    if (!st.isDirectory) throw fsError('ENOTDIR', path);
    if (path === '/') throw fsError('EBUSY', 'the root of a mount');
    await this.finishUnder(at);
    if ((await this.fs.readdir(at)).length > 0) throw fsError('ENOTEMPTY', path);
    await this.fs.rm(at);
  }

  async unlink(path: string): Promise<void> {
    const at = this.full(path);
    const draft = this.drafts.get(at);
    if (draft && !this.writing(at)) {
      this.drafts.delete(at);
      this.closed.delete(at);
      await draft.abandon();
      if (draft.created) return;
    }
    await this.finish(at);
    const st = await this.fs.lstat(at);
    if (st.isDirectory) throw fsError('EISDIR', path);
    await this.fs.rm(at);
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.full(from);
    const b = this.full(to);
    await this.finishUnder(a);
    await this.finishUnder(b);
    await this.fs.rename(a, b);
  }

  async link(from: string, to: string): Promise<void> {
    const a = this.full(from);
    await this.finish(a);
    if (!this.fs.link) throw fsError('EPERM', 'this file system has no hard links');
    await this.fs.link(a, this.full(to));
  }

  async setattr(path: string, change: DriverSetAttr): Promise<void> {
    const at = this.full(path);
    if (change.size !== undefined) await this.truncateTo(at, change.size);
    if (change.mode === undefined) return;
    const mode = change.mode & 0o7777;
    const draft = this.drafts.get(at);
    if (!draft?.created) await this.fs.chmod(at, mode);
    if (draft) {
      draft.mode = mode;
      draft.modeChanged = true;
    }
  }
}

export function workspaceDriver(
  fs: WorkspaceFilesystemLike,
  options: WorkspaceDriverOptions = {}
): WorkspaceDriver {
  const root = (options.root ?? '/').replace(/\/+$/, '');
  const state = new DriverState(
    fs,
    root,
    options.bufferBytes ?? BUFFER_BYTES,
    writeBehindOf(options.writeBehind)
  );
  const serial = <T>(work: () => Promise<T>) => state.serial(work);
  let served: ServedFilesystem | undefined;
  const capabilities: DriverCapabilities = {
    symlinks: true,
    chmod: true,
    ranges: true,
    sessions: true,
    maxIo: options.maxIo ?? MAX_IO,
    attrTtl: options.attrTtl ?? ATTR_TTL,
    ...(fs.link ? { links: true } : {}),
  };
  return {
    capabilities,
    settled: () => state.settled(),
    flush: (open) => serial(() => state.flush(open)),
    pending: () => state.drafts.size > 0,
    served: (next) => {
      served = next;
    },
    invalidate: (paths) => served?.invalidate(paths ?? true),
    mount: () =>
      serial(async () => {
        if (root) await fs.mkdir(root, { recursive: true });
        return undefined;
      }),
    getattr: (path) => serial(() => state.getattr(path)),
    readdir: (path) => serial(() => state.readdir(path)),
    open: (path, flags) => serial(() => state.open(path, flags)),
    read: (fh, offset, size) => serial(() => state.read(fh, offset, size)),
    write: (fh, offset, bytes) => serial(() => state.write(fh, offset, bytes)),
    release: (fh) => serial(() => state.release(fh)),
    mkdir: (path) =>
      serial(async () => {
        await state.finish(state.full(path));
        await fs.mkdir(state.full(path));
      }),
    rmdir: (path) => serial(() => state.rmdir(path)),
    unlink: (path) => serial(() => state.unlink(path)),
    rename: (from, to) => serial(() => state.rename(from, to)),
    ...(fs.link ? { link: (from: string, to: string) => serial(() => state.link(from, to)) } : {}),
    symlink: (target, path) =>
      serial(async () => {
        await state.finish(state.full(path));
        await fs.symlink(target, state.full(path));
      }),
    readlink: (path) =>
      serial(async () => {
        if (state.drafts.get(state.full(path))?.created) throw fsError('EINVAL', path);
        return fs.readlink(state.full(path));
      }),
    setattr: (path, change) => serial(() => state.setattr(path, change)),
    statfs: async () => ({ bsize: 4096, blocks: 1 << 30, bfree: 1 << 30 }),
  };
}
