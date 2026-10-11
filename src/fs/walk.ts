import { fsError } from './types.ts';

export interface LinkReader {
  readlink?(path: string): Promise<string>;
  lstat?(path: string): Promise<unknown>;
}

const MAX_LINKS = 40;

export function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

async function mustBeDir(fs: LinkReader, path: string): Promise<void> {
  if (!fs.lstat) return;
  const st = await fs.lstat(path);
  if ((st as { isDirectory?: boolean }).isDirectory !== true) throw fsError('ENOTDIR', path);
}

async function linkOf(fs: LinkReader, path: string): Promise<string | undefined> {
  return fs.readlink?.(path).catch(() => undefined);
}

interface Budget {
  hops: number;
}

export async function realDir(
  fs: LinkReader,
  dir: string,
  budget: Budget = { hops: 0 }
): Promise<string> {
  const queue = dir.split('/').filter(Boolean);
  let at = '/';
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      at = parentOf(at);
      continue;
    }
    const next = at === '/' ? `/${part}` : `${at}/${part}`;
    const link = await linkOf(fs, next);
    if (link === undefined) {
      if (queue.find((p) => p !== '.') === '..') await mustBeDir(fs, next);
      at = next;
      continue;
    }
    if (budget.hops >= MAX_LINKS) throw fsError('ELOOP', dir);
    budget.hops++;
    queue.unshift(...link.split('/').filter(Boolean));
    if (link.startsWith('/')) at = '/';
  }
  return at;
}

export function joinName(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export async function realTarget(fs: LinkReader, path: string): Promise<string> {
  const budget: Budget = { hops: 0 };
  let dir = await realDir(fs, parentOf(path), budget);
  let name = path.slice(path.lastIndexOf('/') + 1);
  for (;;) {
    const link = await linkOf(fs, joinName(dir, name));
    if (link === undefined) break;
    if (budget.hops >= MAX_LINKS) throw fsError('ELOOP', path);
    budget.hops++;
    const target = link.startsWith('/') ? link : joinName(dir, link);
    dir = await realDir(fs, parentOf(target), budget);
    name = target.slice(target.lastIndexOf('/') + 1);
  }
  return joinName(dir, name);
}
