import { MemoryMeta, type MetaEntry, type MetaStore } from './meta.ts';
import { type FsStat, fsError, inodeOf, type KernelFs, resolvePath } from './types.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const PERM_MASK = 0o7777;
const READ_ATTEMPTS = 3;
const MAX_LINKS = 40;
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

function isHandle(child: Handle | MetaEntry): child is Handle {
  return 'kind' in child;
}

export class OpfsFs implements KernelFs {
  private readonly root: FileSystemDirectoryHandle;
  private readonly meta: MetaStore;

  constructor(root: FileSystemDirectoryHandle, meta: MetaStore = new MemoryMeta()) {
    this.root = root;
    this.meta = meta;
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  private async dir(path: string): Promise<FileSystemDirectoryHandle> {
    let dir = this.root;
    try {
      for (const part of split(path)) dir = await dir.getDirectoryHandle(part);
    } catch (err) {
      throw translate(err, path);
    }
    return dir;
  }

  private async parent(path: string): Promise<[FileSystemDirectoryHandle, string]> {
    const parts = split(path);
    const name = parts.pop();
    if (name === undefined) throw fsError('EBUSY', path);
    return [await this.dir(`/${parts.join('/')}`), name];
  }

  private async handle(path: string): Promise<Handle> {
    if (split(path).length === 0) return this.root;
    const [dir, name] = await this.parent(path);
    try {
      return await dir.getFileHandle(name);
    } catch (err) {
      if ((err as { name?: unknown })?.name !== 'TypeMismatchError') throw translate(err, path);
    }
    return dir.getDirectoryHandle(name);
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
      ctime: new Date(meta?.ctimeMs ?? mtime),
      ino: meta?.ino ?? inodeOf(path),
    };
  }

  private linkStat(entry: MetaEntry): FsStat {
    const time = new Date(entry.mtimeMs ?? 0);
    return {
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
      size: (entry.link as string).length,
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

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const handle = (await this.locate(path, true)).handle as Handle;
    if (handle.kind === 'directory') throw fsError('EISDIR', path);
    for (let attempt = 1; ; attempt++) {
      try {
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (err) {
        if ((err as { name?: unknown })?.name !== 'NotReadableError' || attempt >= READ_ATTEMPTS) {
          throw translate(err, path);
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
      }
    }
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  private async writeTarget(path: string): Promise<string> {
    try {
      return (await this.locate(path, true)).path;
    } catch (err) {
      if (!missing(err)) throw err;
    }
    const [entry] = await this.meta.get([path]);
    const wanted = entry?.link === undefined ? path : resolvePath(parentOf(path), entry.link);
    return resolvePath((await this.locate(parentOf(wanted), true)).path, baseOf(wanted));
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    const target = await this.writeTarget(path);
    const [dir, name] = await this.parent(target);
    let file: FileSystemFileHandle;
    try {
      file = await dir.getFileHandle(name, { create: true });
    } catch (err) {
      const code = (err as { name?: unknown })?.name === 'TypeMismatchError' ? 'EISDIR' : null;
      throw code ? fsError(code, path) : translate(err, path);
    }
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
        await dir.removeEntry(name, { recursive: options.recursive === true });
      } catch (err) {
        throw translate(err, path);
      }
    }
    await this.meta.remove([found.path]);
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    const source = await this.locate(from, false);
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
  }

  private async modified(path: string): Promise<number> {
    const handle = await this.handle(path);
    return handle.kind === 'file' ? (await handle.getFile()).lastModified : 0;
  }

  private async explicitTimes(path: string): Promise<string[]> {
    const timed: string[] = [];
    for (const entry of await this.meta.under(path)) {
      if (entry.mtimeMs === undefined) continue;
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
