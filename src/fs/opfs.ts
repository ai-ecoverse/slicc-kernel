import { type FsStat, fsError, type KernelFs, resolvePath } from './types.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const PERM_MASK = 0o7777;
const EXECUTABLE = /\/node_modules\/(?:@[^/]+\/)?[^/]+\/bin\//;

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface MovableHandle {
  move?(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
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

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export class OpfsFs implements KernelFs {
  private readonly modes = new Map<string, number>();
  private readonly times = new Map<string, number>();

  private readonly root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  private async dir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let dir = this.root;
    try {
      for (const part of split(path)) dir = await dir.getDirectoryHandle(part, { create });
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

  private mode(path: string, directory: boolean): number {
    const fallback = directory || EXECUTABLE.test(path) ? 0o755 : 0o644;
    return (directory ? S_IFDIR : S_IFREG) | (this.modes.get(path) ?? fallback);
  }

  async stat(path: string): Promise<FsStat> {
    const handle = await this.handle(path);
    const directory = handle.kind === 'directory';
    const file = directory ? undefined : await (handle as FileSystemFileHandle).getFile();
    return {
      isFile: !directory,
      isDirectory: directory,
      isSymbolicLink: false,
      size: file?.size ?? 0,
      mode: this.mode(path, directory),
      mtime: new Date(this.times.get(path) ?? file?.lastModified ?? 0),
    };
  }

  lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.handle(path).then(
      () => true,
      () => false
    );
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const handle = await this.handle(path);
    if (handle.kind === 'directory') throw fsError('EISDIR', path);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    const [dir, name] = await this.parent(path);
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
    this.times.delete(path);
  }

  async readdir(path: string): Promise<string[]> {
    const handle = await this.handle(path);
    if (handle.kind !== 'directory') throw fsError('ENOTDIR', path);
    const names: string[] = [];
    for await (const name of handle.keys()) names.push(name);
    return names.sort();
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (options.recursive) {
      await this.dir(path, true);
      return;
    }
    if (await this.exists(path)) throw fsError('EEXIST', path);
    const [dir, name] = await this.parent(path);
    await dir.getDirectoryHandle(name, { create: true });
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    try {
      const [dir, name] = await this.parent(path);
      await dir.removeEntry(name, { recursive: options.recursive === true });
    } catch (err) {
      const error = translate(err, path) as Error & { code: string };
      if (options.force && error.code === 'ENOENT') return;
      throw error;
    }
    this.forget(path);
  }

  private forget(path: string): void {
    for (const map of [this.modes, this.times]) {
      for (const key of [...map.keys()]) if (within(key, path)) map.delete(key);
    }
  }

  private carry(from: string, to: string): void {
    for (const map of [this.modes, this.times]) {
      for (const [key, value] of [...map]) {
        if (!within(key, from)) continue;
        map.delete(key);
        map.set(to + key.slice(from.length), value);
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    const source = await this.stat(from);
    if (source.isDirectory && within(to, from)) throw fsError('EINVAL', to);
    const target = await this.stat(to).catch(() => null);
    if (target?.isDirectory && !source.isDirectory) throw fsError('EISDIR', to);
    if (target && !target.isDirectory && source.isDirectory) throw fsError('ENOTDIR', to);
    if (target?.isDirectory && (await this.readdir(to)).length > 0) {
      throw fsError('ENOTEMPTY', to);
    }
    const [dir, name] = await this.parent(to);
    const handle = await this.handle(from);
    const swap = target?.isDirectory === true;
    const staging = swap ? `.${name}.${crypto.randomUUID()}` : name;
    const moved = await this.place(handle, dir, staging);
    if (swap) await this.rm(to, { recursive: true });
    this.carry(from, to);
    if (!moved) await this.rm(from, { recursive: true });
    if (!swap) return;
    const staged = await dir.getDirectoryHandle(staging);
    if (!(await this.place(staged, dir, name))) await dir.removeEntry(staging, { recursive: true });
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

  async symlink(_target: string, path: string): Promise<void> {
    throw fsError('ENOSYS', path);
  }

  async readlink(path: string): Promise<string> {
    await this.handle(path);
    throw fsError('EINVAL', path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.handle(path);
    this.modes.set(path, mode & PERM_MASK);
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    await this.handle(path);
    this.times.set(path, mtime.getTime());
  }
}
