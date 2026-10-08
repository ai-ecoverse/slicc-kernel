import { type FilesystemHandlers, fsError } from './driver.ts';
import type { DriverAttr, DriverStatfs } from './protocol.ts';

export type MediumHandlers = Required<Omit<FilesystemHandlers, 'mount' | 'statfs'>> &
  Pick<FilesystemHandlers, 'statfs'>;

export interface MediumSlot<K> {
  readonly handlers: FilesystemHandlers;
  present(): boolean;
  insert(key: K, handlers: MediumHandlers): void;
  eject(): void;
}

const EMPTY_ROOT: DriverAttr = { kind: 'directory', size: 0, mtime: 0, mode: 0o40755 };

export const absent = () => fsError('ENOMEDIUM', 'No medium found');

export function mediumSlot<K>(
  lost: (err: unknown, key: K) => Promise<boolean>,
  onLost: (key: K) => void
): MediumSlot<K> {
  let current: { key: K; handlers: MediumHandlers } | undefined;
  function wrap<A extends unknown[], R>(
    pick: (h: MediumHandlers) => (...args: A) => Promise<R>
  ): (...args: A) => Promise<R> {
    return async (...args) => {
      const medium = current;
      if (!medium) throw absent();
      try {
        return await pick(medium.handlers)(...args);
      } catch (err) {
        if (!(await lost(err, medium.key))) throw err;
        if (current === medium) {
          current = undefined;
          onLost(medium.key);
        }
        throw absent();
      }
    };
  }
  const getattr = wrap((h) => h.getattr);
  const readdir = wrap((h) => h.readdir);
  const statfs = wrap((h) => async () => (await h.statfs?.()) ?? null);
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
      statfs: () => (current ? statfs() : Promise.resolve(null)) as Promise<DriverStatfs>,
    },
    present: () => current !== undefined,
    insert(key, handlers) {
      current = { key, handlers };
    },
    eject() {
      current = undefined;
    },
  };
}
