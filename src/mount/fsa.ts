import { OpfsFs } from '../fs/opfs.ts';
import type { FsStat, KernelFs } from '../fs/types.ts';
import { type FilesystemHandlers, fsError, type OpenFlags } from './driver.ts';
import type { DriverAttr, DriverCapabilities, DriverEntry } from './protocol.ts';

export const FSA_CAPABILITIES: DriverCapabilities = { listingStats: true };

export interface PermissionHandle {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export type MediumHandle = FileSystemDirectoryHandle & PermissionHandle;

type Handlers = Required<Omit<FilesystemHandlers, 'mount' | 'statfs'>>;

interface Opened {
  path: string;
  data: Uint8Array;
  length: number;
  dirty: boolean;
}

const codeOf = (err: unknown) => (err as { code?: unknown } | null)?.code;
const denied = (err: unknown) =>
  codeOf(err) === 'EACCES' || (err as { name?: unknown } | null)?.name === 'NotAllowedError';

function attrOf(st: FsStat): DriverAttr {
  return {
    kind: st.isDirectory ? 'directory' : st.isSymbolicLink ? 'symlink' : 'file',
    size: st.size,
    mtime: st.mtime.getTime(),
    mode: st.mode,
    ino: st.ino,
  };
}

export function kernelFsHandlers(fs: KernelFs): Handlers {
  const handles = new Map<number, Opened>();
  let nextFh = 0;
  const handle = (fh: number): Opened => {
    const found = handles.get(fh);
    if (!found) throw fsError('EBADF', `handle ${fh}`);
    return found;
  };
  async function existing(path: string): Promise<FsStat | undefined> {
    try {
      return await fs.stat(path);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return undefined;
      throw err;
    }
  }
  return {
    getattr: async (path) => attrOf(await fs.lstat(path)),
    readdir: async (path) =>
      (await fs.readdirStat(path)).flatMap(([name, st]): DriverEntry[] => {
        if (!st) return [];
        const attr = attrOf(st);
        return [{ name, kind: attr.kind, attr }];
      }),
    async open(path: string, flags: OpenFlags) {
      const st = await existing(path);
      if (st && flags.exclusive) throw fsError('EEXIST', path);
      if (st?.isDirectory && flags.write) throw fsError('EISDIR', path);
      if (!st && !flags.create) throw fsError('ENOENT', path);
      const data = st && !flags.truncate ? await fs.readFileBuffer(path) : new Uint8Array(0);
      handles.set(++nextFh, { path, data, length: data.length, dirty: !st || flags.truncate });
      return nextFh;
    },
    async read(fh, offset, size) {
      const h = handle(fh);
      return h.data.slice(offset, Math.min(h.length, offset + size));
    },
    async write(fh, offset, bytes) {
      const h = handle(fh);
      const end = offset + bytes.length;
      if (end > h.data.length) {
        const grown = new Uint8Array(Math.max(end, h.data.length * 2));
        grown.set(h.data.subarray(0, h.length));
        h.data = grown;
      }
      h.data.set(bytes, offset);
      h.length = Math.max(h.length, end);
      h.dirty = true;
    },
    async release(fh) {
      const h = handle(fh);
      handles.delete(fh);
      if (h.dirty) await fs.writeFile(h.path, h.data.slice(0, h.length));
    },
    mkdir: (path) => fs.mkdir(path),
    async rmdir(path) {
      if (!(await fs.lstat(path)).isDirectory) throw fsError('ENOTDIR', path);
      if ((await fs.readdir(path)).length > 0) throw fsError('ENOTEMPTY', path);
      await fs.rm(path);
    },
    async unlink(path) {
      if ((await fs.lstat(path)).isDirectory) throw fsError('EISDIR', path);
      await fs.rm(path);
    },
    rename: (from, to) => fs.rename(from, to),
    symlink: (target, path) => fs.symlink(target, path),
    readlink: (path) => fs.readlink(path),
    async setattr(path, change) {
      if (change.mode !== undefined) await fs.chmod(path, change.mode);
      if (change.mtime !== undefined) {
        await fs.utimes(path, new Date(change.mtime), new Date(change.mtime));
      }
    },
  };
}

const EMPTY_ROOT: DriverAttr = { kind: 'directory', size: 0, mtime: 0, mode: 0o40755 };

export interface Medium {
  readonly handlers: FilesystemHandlers;
  present(): boolean;
  insert(handle: MediumHandle): void;
  eject(): void;
}

export function granted(handle: PermissionHandle): Promise<boolean> {
  if (!handle.queryPermission) return Promise.resolve(true);
  return handle.queryPermission({ mode: 'readwrite' }).then(
    (state) => state === 'granted',
    () => false
  );
}

export function removableMedium(
  onLost: (handle: MediumHandle) => void,
  open: (handle: MediumHandle) => KernelFs = (handle) => new OpfsFs(handle)
): Medium {
  let current: { handle: MediumHandle; handlers: Handlers } | undefined;
  const absent = () => fsError('ENOMEDIUM', 'No medium found');
  function wrap<A extends unknown[], R>(
    pick: (h: Handlers) => (...args: A) => Promise<R>
  ): (...args: A) => Promise<R> {
    return async (...args) => {
      const medium = current;
      if (!medium) throw absent();
      try {
        return await pick(medium.handlers)(...args);
      } catch (err) {
        if (!denied(err) || (await granted(medium.handle))) throw err;
        if (current === medium) {
          current = undefined;
          onLost(medium.handle);
        }
        throw absent();
      }
    };
  }
  const getattr = wrap((h) => h.getattr);
  const readdir = wrap((h) => h.readdir);
  return {
    handlers: {
      getattr: (path) => (current || path !== '/' ? getattr(path) : Promise.resolve(EMPTY_ROOT)),
      readdir: (path) => (current || path !== '/' ? readdir(path) : Promise.resolve([])),
      open: wrap((h) => h.open),
      read: wrap((h) => h.read),
      write: wrap((h) => h.write),
      release: wrap((h) => h.release),
      mkdir: wrap((h) => h.mkdir),
      rmdir: wrap((h) => h.rmdir),
      unlink: wrap((h) => h.unlink),
      rename: wrap((h) => h.rename),
      symlink: wrap((h) => h.symlink),
      readlink: wrap((h) => h.readlink),
      setattr: wrap((h) => h.setattr),
    },
    present: () => current !== undefined,
    insert(handle) {
      current = { handle, handlers: kernelFsHandlers(open(handle)) };
    },
    eject() {
      current = undefined;
    },
  };
}
