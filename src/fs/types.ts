export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  ino: number;
  dev?: number;
  readonly?: boolean;
  maxFile?: number;
  ranged?: boolean;
  version?: string;
}

export interface KernelFs {
  resolvePath(base: string, path: string): string;
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  lstat(path: string): Promise<FsStat>;
  readdir(path: string): Promise<string[]>;
  readdirStat(path: string): Promise<Array<[string, FsStat | null]>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath?(path: string, follow: boolean): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  lutimes?(path: string, atime: Date, mtime: Date): Promise<void>;
  pread?(path: string, offset: number, length: number, version?: string): Promise<Uint8Array>;
  pwrite?(path: string, offset: number, bytes: Uint8Array, transfer?: boolean): Promise<void>;
  truncate?(path: string, size: number): Promise<void>;
}

export type RangedOps = Required<Pick<KernelFs, 'pread' | 'pwrite' | 'truncate'>>;

export function rangedOps(fs: Partial<RangedOps>): RangedOps | undefined {
  const { pread, pwrite, truncate } = fs;
  if (!pread || !pwrite || !truncate) return undefined;
  return { pread: pread.bind(fs), pwrite: pwrite.bind(fs), truncate: truncate.bind(fs) };
}

export async function lutimesOf(
  fs: KernelFs,
  path: string,
  atime: Date,
  mtime: Date
): Promise<void> {
  if (fs.lutimes) return fs.lutimes(path, atime, mtime);
  if ((await fs.lstat(path)).isSymbolicLink) throw fsError('EOPNOTSUPP', path);
  return fs.utimes(path, atime, mtime);
}

export function fsError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function resolvePath(base: string, path: string): string {
  return normalizePath(path.startsWith('/') ? path : `${base}/${path}`);
}

export function inodeOf(path: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0) || 1;
}
