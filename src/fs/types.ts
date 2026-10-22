export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  isSocket?: boolean;
  isFifo?: boolean;
  size: number;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  ino: number;
  nlink?: number;
  dev?: number;
  readonly?: boolean;
  maxFile?: number;
  ranged?: boolean;
  linkable?: boolean;
  version?: string;
  uid?: number;
  gid?: number;
}

export type UsersMode = 'off' | 'report' | 'enforce';

export const DEFAULT_USERS: UsersMode = 'enforce';

export interface Owner {
  uid: number;
  gid: number;
}

export interface Perm {
  uid: number;
  gid: number;
  mode?: number;
  link?: string;
}

export interface NewOwner extends Owner {
  mode?: number;
  parents?: number;
  socket?: boolean;
  fifo?: boolean;
}

export interface CopyOptions {
  exclusive: boolean;
  owner?: NewOwner;
}

export interface OwnerChange {
  uid?: number;
  gid?: number;
  follow?: boolean;
  kind?: 'chown' | 'adopt' | 'new';
  mode?: number;
}

export interface HeldEntry {
  writeFile: KernelFs['writeFile'];
  direct: boolean;
}

export interface Peers {
  joined(): Promise<unknown>;
  crowded(): boolean;
  watch(listener: (crowded: boolean) => void): void;
  fresh?(): void;
}

export interface KernelFs {
  resolvePath(base: string, path: string): string;
  exclusive?<T>(path: string, run: (held: HeldEntry) => Promise<T>, follow?: boolean): Promise<T>;
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array | string, owner?: NewOwner): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  lstat(path: string): Promise<FsStat>;
  readdir(path: string): Promise<string[]>;
  readdirStat(path: string): Promise<Array<[string, FsStat | null]>>;
  mkdir(path: string, options?: { recursive?: boolean; owner?: NewOwner }): Promise<void>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean; file?: boolean }
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string, follow?: boolean): Promise<void>;
  links?(path: string): boolean;
  symlink(target: string, path: string, owner?: NewOwner): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath?(path: string, follow: boolean): Promise<string>;
  createExclusive?(path: string, owner?: NewOwner): Promise<void>;
  copyFile?(from: string, to: string, options: CopyOptions): Promise<void>;
  readonly rootName?: string;
  chown?(path: string, change: OwnerChange): Promise<void>;
  trackOwners?(): void;
  onPeer?(settle: () => Promise<void>): void;
  heldBy?(held: (dir: string) => readonly string[]): void;
  remoteChanges?(
    listener: (change: {
      paths: readonly string[];
      trees?: readonly string[];
      moved?: { from: string; to: string };
    }) => void
  ): () => void;
  peers?(): Peers | undefined;
  crossings?(mounted: (path: string) => boolean): void;
  ancestry?(path: string): Promise<Array<Perm | undefined>>;
  hasOwner?(path: string): Promise<boolean>;
  chmod(path: string, mode: number): Promise<void>;
  append?(path: string, bytes: Uint8Array): Promise<number>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  lutimes?(path: string, atime: Date, mtime: Date): Promise<void>;
  pread?(path: string, offset: number, length: number, version?: string): Promise<Uint8Array>;
  pwrite?(path: string, offset: number, bytes: Uint8Array, transfer?: boolean): Promise<void>;
  truncate?(path: string, size: number): Promise<void>;
  protect?(prefixes: readonly string[], versions?: boolean): void;
  unguarded?(): KernelFs;
  noLinks?(): KernelFs;
  mayChange?(path: string, follow: boolean, whole?: boolean): Promise<void>;
  commandTarget?(path: string): Promise<string | undefined>;
  readVersioned?(path: string, cached?: boolean): Promise<{ bytes: Uint8Array; version: string }>;
  version?(path: string, cached?: boolean): Promise<string>;
  opfsCalls?(): number;
  renameWaits?(): {
    acks: number;
    busy: number;
    waits: number;
    queries: number;
    ackMs: readonly number[];
  };
  opfsOps?(): number;
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

export function mayLink(fs: { links?(path: string): boolean }, path: string): boolean {
  return fs.links?.(path) ?? true;
}

export function modeOption(mode: unknown): number {
  if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777) {
    throw fsError('EINVAL', `not a mode: ${String(mode)}`);
  }
  return mode as number;
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

export interface Redirect {
  of: string;
  to: string;
}

export function redirected(of: string, to: string): Error {
  return Object.assign(fsError('EXDEV', `${of} leads to the mount at ${to}`), {
    redirect: { of: normalizePath(of), to: normalizePath(to) },
  });
}

export function redirectOf(err: unknown): Redirect | undefined {
  return (err as { redirect?: Redirect } | null)?.redirect;
}
