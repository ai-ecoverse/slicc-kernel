export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: Date;
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
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
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
