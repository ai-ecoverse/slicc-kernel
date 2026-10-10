import { OpfsFs, type WriteSession } from '../fs/opfs.ts';
import type { FsStat, KernelFs } from '../fs/types.ts';
import { type FilesystemHandlers, fsError, type OpenFlags } from './driver.ts';
import { mediumSlot } from './medium.ts';
import type { DriverAttr, DriverCapabilities, DriverEntry } from './protocol.ts';

export const FSA_CAPABILITIES: DriverCapabilities = {
  listingStats: true,
  ranges: true,
  sessions: true,
};

export interface PermissionHandle {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export type MediumHandle = FileSystemDirectoryHandle & PermissionHandle;

type Handlers = Required<Omit<FilesystemHandlers, 'mount' | 'statfs'>>;

export type SessionFs = KernelFs & Pick<OpfsFs, 'writeSession' | 'pread'>;

interface Opened {
  path: string;
  session?: Promise<WriteSession>;
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

export function kernelFsHandlers(fs: SessionFs): Handlers {
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
      if (!st || flags.truncate) await fs.writeFile(path, new Uint8Array(0));
      handles.set(++nextFh, { path });
      return nextFh;
    },
    read: async (fh, offset, size) => fs.pread(handle(fh).path, offset, size),
    async write(fh, offset, bytes) {
      const h = handle(fh);
      h.session ??= fs.writeSession(h.path, false);
      await (await h.session).write(offset, bytes);
    },
    async release(fh) {
      const h = handle(fh);
      handles.delete(fh);
      if (h.session !== undefined) await (await h.session).close();
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
      if (change.size !== undefined) {
        const open = [...handles.values()].find(
          (h) => h.path === path && h.session !== undefined
        )?.session;
        if (open !== undefined) await (await open).truncate(change.size);
        else await fs.truncate?.(path, change.size);
      }
      if (change.mode !== undefined) await fs.chmod(path, change.mode);
      if (change.mtime !== undefined) {
        await fs.utimes(path, new Date(change.mtime), new Date(change.mtime));
      }
    },
  };
}

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
  open: (handle: MediumHandle) => SessionFs = (handle) => new OpfsFs(handle)
): Medium {
  const slot = mediumSlot<MediumHandle>(
    async (err, handle) => denied(err) && !(await granted(handle)),
    onLost
  );
  return {
    handlers: slot.handlers,
    present: slot.present,
    insert: (handle) => slot.insert(handle, kernelFsHandlers(open(handle))),
    eject: slot.eject,
  };
}
