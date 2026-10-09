import { MemoryMeta, type MetaEntry, type MetaStore } from './meta.ts';
import { type FsStat, fsError, inodeOf, type KernelFs, resolvePath } from './types.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const PERM_MASK = 0o7777;
const READ_ATTEMPTS = 3;
const MAX_LINKS = 40;
const CHECK_MS = 1000;
const EXECUTABLE = /\/node_modules\/(?:@[^/]+\/)?[^/]+\/bin\//;

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface MovableHandle {
  move?(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
}

interface Located {
  path: string;
  handle?: Handle;
  link?: MetaEntry;
}

const ERRNO_BY_DOM_ERROR: Readonly<Record<string, string>> = {
  NotFoundError: 'ENOENT',
  TypeMismatchError: 'ENOTDIR',
  InvalidModificationError: 'ENOTEMPTY',
  NoModificationAllowedError: 'EBUSY',
  TypeError: 'EINVAL',
  NotAllowedError: 'EACCES',
};

function translate(err: unknown, path: string): Error {
  if (typeof (err as { code?: unknown })?.code === 'string') return err as Error;
  const name = (err as { name?: unknown })?.name;
  return fsError((typeof name === 'string' && ERRNO_BY_DOM_ERROR[name]) || 'EIO', path);
}

function missing(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function prefixes(path: string): string[] {
  const parts = split(path);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

interface Positioned {
  write(at: number, bytes: Uint8Array): unknown;
  truncate(size: number): unknown;
}

interface SyncAccess {
  write(bytes: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

type SyncCapable = FileSystemFileHandle & {
  createSyncAccessHandle?(options?: { mode?: string }): Promise<SyncAccess>;
};

const LOCKED = new Set(['NotReadableError', 'NoModificationAllowedError', 'InvalidStateError']);

async function positioned(handle: FileSystemFileHandle, op: (io: Positioned) => unknown) {
  const sync = (handle as SyncCapable).createSyncAccessHandle;
  if (sync) {
    const access = await sync.call(handle, { mode: 'readwrite-unsafe' });
    try {
      op({
        write: (at, bytes) => access.write(bytes, { at }),
        truncate: (n) => access.truncate(n),
      });
      access.flush();
    } finally {
      access.close();
    }
    return;
  }
  const writable = await handle.createWritable({ keepExistingData: true });
  try {
    await op({
      write: (at, bytes) =>
        writable.write({ type: 'write', position: at, data: bytes as Uint8Array<ArrayBuffer> }),
      truncate: (n) => writable.truncate(n),
    });
  } catch (err) {
    await writable.abort();
    throw err;
  }
  await writable.close();
}

export function syncAccessHandles(scope: object = globalThis): boolean {
  const handle = (scope as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  return handle !== undefined && 'createSyncAccessHandle' in handle.prototype;
}

function isHandle(child: Handle | MetaEntry): child is Handle {
  return 'kind' in child;
}

export class OpfsFs implements KernelFs {
  private readonly root: FileSystemDirectoryHandle;
  private readonly meta: MetaStore;
  private readonly dirs = new Map<string, FileSystemDirectoryHandle>();
  private readonly checked = new WeakMap<FileSystemDirectoryHandle, number>();

  private readonly channel: BroadcastChannel | undefined;
  private readonly ranged: boolean;

  constructor(
    root: FileSystemDirectoryHandle,
    meta: MetaStore = new MemoryMeta(),
    channel?: string,
    options: { ranged?: boolean } = {}
  ) {
    this.root = root;
    this.meta = meta;
    this.ranged = options.ranged === true;
    this.channel = channel === undefined ? undefined : new BroadcastChannel(channel);
    if (this.channel) {
      this.channel.onmessage = ({ data }) => {
        for (const path of data as string[]) this.forget(path);
      };
      (this.channel as BroadcastChannel & { unref?: () => void }).unref?.();
    }
  }

  private changed(...paths: string[]): void {
    for (const path of paths) this.forget(path);
    this.channel?.postMessage(paths);
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  private async walk(parts: string[], from: number, start: FileSystemDirectoryHandle) {
    let dir = start;
    for (let at = from; at < parts.length; at++) {
      dir = await dir.getDirectoryHandle(parts[at] as string);
      this.dirs.set(`/${parts.slice(0, at + 1).join('/')}`, dir);
      this.checked.set(dir, performance.now());
    }
    return dir;
  }

  private async dir(path: string): Promise<FileSystemDirectoryHandle> {
    const parts = split(path);
    let from = parts.length;
    let cached: FileSystemDirectoryHandle | undefined;
    for (; from > 0 && !cached; from--)
      cached = this.dirs.get(`/${parts.slice(0, from).join('/')}`);
    if (cached) from++;
    const at = `/${parts.slice(0, from).join('/')}`;
    if (cached && !(await this.current(at, cached))) {
      this.forget(at);
      cached = undefined;
      from = 0;
    }
    try {
      return await this.walk(parts, from, cached ?? this.root);
    } catch (err) {
      throw translate(err, path);
    }
  }

  private async current(path: string, dir: FileSystemDirectoryHandle): Promise<boolean> {
    if (performance.now() - (this.checked.get(dir) ?? -CHECK_MS) < CHECK_MS) return true;
    const where = await this.root.resolve(dir).catch(() => null);
    if (where === null || `/${where.join('/')}` !== path) return false;
    this.checked.set(dir, performance.now());
    return true;
  }

  private forget(path: string): void {
    for (const key of [...this.dirs.keys()]) if (within(key, path)) this.dirs.delete(key);
  }

  private async inDir<T>(path: string, op: (dir: FileSystemDirectoryHandle) => Promise<T>) {
    const dir = await this.dir(path);
    try {
      return await op(dir);
    } catch (err) {
      if ((err as { name?: unknown })?.name !== 'NotFoundError' || (await this.current(path, dir)))
        throw err;
      this.forget(path);
      return op(await this.dir(path));
    }
  }

  private async child(
    parent: FileSystemDirectoryHandle,
    name: string,
    kind: 'file' | 'directory'
  ): Promise<Handle> {
    return kind === 'file' ? parent.getFileHandle(name) : parent.getDirectoryHandle(name);
  }

  private async parent(path: string): Promise<[string, string]> {
    const parts = split(path);
    const name = parts.pop();
    if (name === undefined) throw fsError('EBUSY', path);
    return [`/${parts.join('/')}`, name];
  }

  private async handle(path: string): Promise<Handle> {
    if (split(path).length === 0) return this.root;
    const [dir, name] = await this.parent(path);
    const known = this.dirs.has(path);
    return this.inDir(dir, async (parent): Promise<Handle> => {
      const [first, second] = known
        ? (['directory', 'file'] as const)
        : (['file', 'directory'] as const);
      try {
        return await this.child(parent, name, first);
      } catch (err) {
        if ((err as { name?: unknown })?.name !== 'TypeMismatchError') throw err;
      }
      return this.child(parent, name, second);
    }).catch((err) => {
      throw translate(err, path);
    });
  }

  private real(path: string): Promise<boolean> {
    return this.handle(path).then(
      () => true,
      () => false
    );
  }

  private async linkAlong(path: string): Promise<MetaEntry | undefined> {
    for (const entry of await this.meta.get(prefixes(path))) {
      if (entry?.link === undefined) continue;
      if (!(await this.real(entry.path)) && (await this.real(parentOf(entry.path)))) return entry;
    }
    return undefined;
  }

  private async locate(path: string, follow: boolean): Promise<Located> {
    let current = path;
    for (let hops = 0; hops <= MAX_LINKS; hops++) {
      try {
        return { path: current, handle: await this.handle(current) };
      } catch (err) {
        if (!missing(err)) throw err;
        const link = await this.linkAlong(current);
        if (!link) throw err;
        if (link.path === current && !follow) return { path: current, link };
        const rest = current.slice(link.path.length);
        current = resolvePath(parentOf(link.path), `${link.link}${rest}`);
      }
    }
    throw fsError('ELOOP', path);
  }

  private mode(path: string, directory: boolean, meta: MetaEntry | undefined): number {
    const fallback = directory || EXECUTABLE.test(path) ? 0o755 : 0o644;
    return (directory ? S_IFDIR : S_IFREG) | (meta?.mode ?? fallback);
  }

  private async statOf(path: string, handle: Handle, meta: MetaEntry | undefined): Promise<FsStat> {
    const directory = handle.kind === 'directory';
    const file = directory ? undefined : await (handle as FileSystemFileHandle).getFile();
    const modified = file?.lastModified ?? 0;
    const mtime =
      meta?.mtimeMs !== undefined && meta.mtimeFor === modified ? meta.mtimeMs : modified;
    return {
      isFile: !directory,
      isDirectory: directory,
      isSymbolicLink: false,
      size: file?.size ?? 0,
      mode: this.mode(path, directory, meta),
      mtime: new Date(mtime),
      atime: new Date(meta?.atimeMs ?? mtime),
      ctime: new Date(Math.max(meta?.ctimeMs ?? mtime, modified)),
      ino: meta?.ino ?? inodeOf(path),
      ...(this.ranged && !directory ? { ranged: true } : {}),
    };
  }

  private linkStat(entry: MetaEntry): FsStat {
    const time = new Date(entry.mtimeMs ?? 0);
    return {
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
      size: new TextEncoder().encode(entry.link).length,
      mode: S_IFLNK | 0o777,
      mtime: time,
      atime: time,
      ctime: new Date(entry.ctimeMs ?? 0),
      ino: entry.ino ?? inodeOf(entry.path),
    };
  }

  private async describe(found: Located): Promise<FsStat> {
    if (found.link) return this.linkStat(found.link);
    const [meta] = await this.meta.get([found.path]);
    return this.statOf(found.path, found.handle as Handle, meta);
  }

  async stat(path: string): Promise<FsStat> {
    return this.describe(await this.locate(path, true));
  }

  async lstat(path: string): Promise<FsStat> {
    return this.describe(await this.locate(path, false));
  }

  async exists(path: string): Promise<boolean> {
    return this.locate(path, true).then(
      () => true,
      () => false
    );
  }

  private async retrying<T>(path: string, op: () => Promise<T>, locks: boolean): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const name = (err as { name?: unknown })?.name;
        const again = name === 'NotReadableError' || (locks && LOCKED.has(name as string));
        if (!again || attempt >= READ_ATTEMPTS) throw translate(err, path);
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
      }
    }
  }

  private async existing(path: string): Promise<FileSystemFileHandle> {
    const handle = (await this.locate(path, true)).handle as Handle;
    if (handle.kind === 'directory') throw fsError('EISDIR', path);
    return handle;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const handle = await this.existing(path);
    return this.retrying(
      path,
      async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()),
      false
    );
  }

  async pread(path: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await this.existing(path);
    return this.retrying(
      path,
      async () =>
        new Uint8Array(await (await handle.getFile()).slice(offset, offset + length).arrayBuffer()),
      false
    );
  }

  async pwrite(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    const handle = (await this.fileFor(path))[0];
    await this.retrying(path, () => positioned(handle, (io) => io.write(offset, bytes)), true);
  }

  async truncate(path: string, size: number): Promise<void> {
    const handle = await this.existing(path);
    await this.retrying(path, () => positioned(handle, (io) => io.truncate(size)), true);
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  private async writeTarget(path: string): Promise<[string, boolean]> {
    try {
      return [(await this.locate(path, true)).path, true];
    } catch (err) {
      if (!missing(err)) throw err;
    }
    const [entry] = await this.meta.get([path]);
    const wanted = entry?.link === undefined ? path : resolvePath(parentOf(path), entry.link);
    return [resolvePath((await this.locate(parentOf(wanted), true)).path, baseOf(wanted)), false];
  }

  private async fileFor(path: string): Promise<[FileSystemFileHandle, boolean]> {
    const [target, existed] = await this.writeTarget(path);
    const [dir, name] = await this.parent(target);
    try {
      return [
        await this.inDir(dir, (parent) => parent.getFileHandle(name, { create: true })),
        existed,
      ];
    } catch (err) {
      const code = (err as { name?: unknown })?.name === 'TypeMismatchError' ? 'EISDIR' : null;
      throw code ? fsError(code, path) : translate(err, path);
    }
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    const [file, existed] = await this.fileFor(path);
    if (!existed && content.length === 0) return;
    const writable = await file.createWritable();
    await writable.write(content as FileSystemWriteChunkType);
    await writable.close();
  }

  private async listing(path: string): Promise<[string, Array<[string, Handle | MetaEntry]>]> {
    const found = await this.locate(path, true);
    const handle = found.handle as Handle;
    if (handle.kind !== 'directory') throw fsError('ENOTDIR', path);
    const children = new Map<string, Handle | MetaEntry>();
    for await (const child of handle.values()) children.set(child.name, child);
    for (const link of await this.meta.links(found.path)) {
      const name = baseOf(link.path);
      if (!children.has(name)) children.set(name, link);
    }
    return [found.path, [...children].sort(([a], [b]) => (a < b ? -1 : 1))];
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.listing(path))[1].map(([name]) => name);
  }

  async readdirStat(path: string): Promise<Array<[string, FsStat | null]>> {
    const [dir, children] = await this.listing(path);
    const base = dir === '/' ? '' : dir;
    const metas = await this.meta.get(children.map(([name]) => `${base}/${name}`));
    return Promise.all(
      children.map(async ([name, child], i): Promise<[string, FsStat | null]> => {
        if (!isHandle(child)) return [name, this.linkStat(child)];
        const stat = await this.statOf(`${base}/${name}`, child, metas[i]).catch(() => null);
        return [name, stat];
      })
    );
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    let found: Located | undefined;
    try {
      found = await this.locate(path, true);
    } catch (err) {
      if (!missing(err)) throw err;
    }
    if (found) {
      const directory = found.handle?.kind === 'directory';
      if (options.recursive && directory) return;
      throw fsError(options.recursive ? 'ENOTDIR' : 'EEXIST', path);
    }
    const [entry] = await this.meta.get([path]);
    if (entry?.link !== undefined) throw fsError('EEXIST', path);
    if (options.recursive) await this.mkdir(parentOf(path), options);
    const parent = await this.locate(parentOf(path), true);
    if (parent.handle?.kind !== 'directory') throw fsError('ENOTDIR', path);
    await parent.handle.getDirectoryHandle(baseOf(path), { create: true });
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    let found: Located;
    try {
      found = await this.locate(path, false);
    } catch (err) {
      const error = translate(err, path) as Error & { code: string };
      if (options.force && error.code === 'ENOENT') return;
      throw error;
    }
    if (found.handle) {
      const [dir, name] = await this.parent(found.path);
      try {
        await this.inDir(dir, (parent) =>
          parent.removeEntry(name, { recursive: options.recursive === true })
        );
      } catch (err) {
        throw translate(err, path);
      }
      this.changed(found.path);
    }
    await this.meta.remove([found.path]);
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    const source = await this.locate(from, false);
    this.forget(source.path);
    const parent = await this.locate(parentOf(to), true);
    const destination = resolvePath(parent.path, baseOf(to));
    const sourceStat = await this.describe(source);
    if (sourceStat.isDirectory && within(destination, source.path)) throw fsError('EINVAL', to);
    const target = await this.locate(destination, false).catch((err) => {
      if (missing(err)) return null;
      throw err;
    });
    const targetStat = target && (await this.describe(target));
    if (targetStat?.isDirectory && !sourceStat.isDirectory) throw fsError('EISDIR', to);
    if (targetStat && !targetStat.isDirectory && sourceStat.isDirectory) {
      throw fsError('ENOTDIR', to);
    }
    if (targetStat?.isDirectory && (await this.readdir(destination)).length > 0) {
      throw fsError('ENOTEMPTY', to);
    }
    const now = Date.now();
    const carry = (entry: MetaEntry | undefined): MetaEntry => ({
      ino: inodeOf(source.path),
      ...entry,
      path: destination,
      ctimeMs: now,
    });
    if (source.link) {
      if (target?.handle) await this.rm(destination);
      await this.meta.move(source.path, destination, carry);
      return;
    }
    const dir = parent.handle as FileSystemDirectoryHandle;
    const name = baseOf(destination);
    const swap = targetStat?.isDirectory === true;
    const staging = swap ? `.${name}.${crypto.randomUUID()}` : name;
    this.forget(destination);
    const timed = await this.explicitTimes(source.path);
    const moved = await this.place(source.handle as Handle, dir, staging);
    if (swap) await this.rm(destination, { recursive: true });
    await this.meta.move(source.path, destination, carry);
    if (!moved) await this.rm(source.path, { recursive: true });
    let copied = !moved;
    if (swap) {
      const staged = await dir.getDirectoryHandle(staging);
      const placed = await this.place(staged, dir, name);
      if (!placed) await dir.removeEntry(staging, { recursive: true });
      copied ||= !placed;
    }
    if (copied) await this.restamp(destination, timed);
    this.changed(source.path, destination);
  }

  private async modified(path: string): Promise<number> {
    const handle = await this.handle(path);
    return handle.kind === 'file' ? (await handle.getFile()).lastModified : 0;
  }

  private async explicitTimes(path: string): Promise<string[]> {
    const timed: string[] = [];
    for (const entry of await this.meta.under(path)) {
      if (entry.mtimeFor === undefined || entry.link !== undefined) continue;
      const current = await this.modified(entry.path).catch(() => undefined);
      if (current === entry.mtimeFor) timed.push(entry.path.slice(path.length));
    }
    return timed;
  }

  private async restamp(path: string, timed: string[]): Promise<void> {
    for (const rest of timed) {
      const mtimeFor = await this.modified(path + rest);
      await this.meta.update(path + rest, (entry) => entry && { ...entry, mtimeFor });
    }
  }

  private async place(handle: Handle, dir: FileSystemDirectoryHandle, name: string) {
    const moved = await (handle as Handle & MovableHandle).move?.(dir, name).then(
      () => true,
      () => false
    );
    if (moved) return true;
    try {
      await this.copy(handle, dir, name);
    } catch (err) {
      if (handle.kind === 'directory') await dir.removeEntry(name, { recursive: true });
      throw translate(err, name);
    }
    return false;
  }

  private async copy(handle: Handle, dir: FileSystemDirectoryHandle, name: string): Promise<void> {
    if (handle.kind === 'file') {
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(await handle.getFile());
      await writable.close();
      return;
    }
    const target = await dir.getDirectoryHandle(name, { create: true });
    for await (const child of handle.values()) await this.copy(child, target, child.name);
  }

  async symlink(target: string, path: string): Promise<void> {
    const parent = await this.locate(parentOf(path), true);
    if (parent.handle?.kind !== 'directory') throw fsError('ENOTDIR', path);
    const at = resolvePath(parent.path, baseOf(path));
    if (
      await this.locate(at, false).then(
        () => true,
        (err) => !missing(err)
      )
    ) {
      throw fsError('EEXIST', path);
    }
    const now = Date.now();
    await this.meta.update(at, () => ({
      path: at,
      link: target,
      dir: parent.path,
      ino: inodeOf(at),
      mtimeMs: now,
      ctimeMs: now,
    }));
  }

  async readlink(path: string): Promise<string> {
    const found = await this.locate(path, false);
    if (found.link) return found.link.link as string;
    throw fsError('EINVAL', path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const found = await this.locate(path, true);
    const ctimeMs = Date.now();
    await this.meta.update(found.path, (entry) => ({
      ...entry,
      path: found.path,
      mode: mode & PERM_MASK,
      ctimeMs,
    }));
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const found = await this.locate(path, true);
    const handle = found.handle as Handle;
    const file = handle.kind === 'file' ? await handle.getFile() : undefined;
    const ctimeMs = Date.now();
    await this.meta.update(found.path, (entry) => ({
      ...entry,
      path: found.path,
      atimeMs: atime.getTime(),
      mtimeMs: mtime.getTime(),
      mtimeFor: file?.lastModified ?? 0,
      ctimeMs,
    }));
  }

  async reconcile(): Promise<number> {
    let removed = 0;
    for (const entry of await this.meta.all()) {
      const real = await this.real(entry.path);
      const stale =
        entry.link === undefined ? !real : real || !(await this.real(parentOf(entry.path)));
      if (!stale) continue;
      await this.meta.update(entry.path, () => undefined);
      removed++;
    }
    return removed;
  }
}
