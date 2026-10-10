import type { SyncFsBridgeStat } from '../../realm/sync-fs-wire.ts';
import { WasiError } from './wasi-files.ts';

const MAX_HOPS = 40;

export interface LinkReader {
  lstat(path: string): SyncFsBridgeStat;
  readlink(path: string): string;
}

export function physicalPath(fs: LinkReader, path: string): string {
  const done: string[] = [];
  let todo = path.split('/').filter((p) => p !== '');
  let hops = 0;
  while (todo.length > 0) {
    const part = todo.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      done.pop();
      continue;
    }
    const at = `/${[...done, part].join('/')}`;
    if (!fs.lstat(at).isSymbolicLink) {
      done.push(part);
      continue;
    }
    if (++hops > MAX_HOPS) throw new WasiError('ELOOP');
    const target = fs.readlink(at);
    if (target.startsWith('/')) done.length = 0;
    todo = [...target.split('/').filter((p) => p !== ''), ...todo];
  }
  return `/${done.join('/')}`;
}

export function physicalOr(fs: LinkReader, path: string): string {
  try {
    return physicalPath(fs, path);
  } catch {
    return path;
  }
}
