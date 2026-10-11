import type { Cred } from '../kernel/cred.ts';
import { chain, inGroup } from './owners.ts';
import { type FsStat, fsError, type KernelFs, type Perm } from './types.ts';

export type { Perm };

import { joinName, parentOf } from './walk.ts';

export const R_OK = 4;
export const W_OK = 2;
export const X_OK = 1;

const MAX_LINKS = 40;
const S_ISVTX = 0o1000;

export interface Walked {
  path: string;
  perm: Perm | undefined;
  denied?: string;
  missing?: boolean;
}

export function permOf(st: FsStat, link?: string): Perm {
  return {
    uid: st.uid ?? 0,
    gid: st.gid ?? 0,
    mode: st.mode & 0o7777,
    ...(link !== undefined ? { link } : {}),
  };
}

export function permits(cred: Readonly<Cred>, perm: Perm, want: number, directory = true): boolean {
  const mode = perm.mode ?? (directory ? 0o755 : 0o644);
  if (cred.euid === 0) return (want & X_OK) === 0 || directory || (mode & 0o111) !== 0;
  const shift = cred.euid === perm.uid ? 6 : inGroup(cred, perm.gid) ? 3 : 0;
  return ((mode >> shift) & want) === want;
}

export function sticky(cred: Readonly<Cred>, dir: Perm, entry: Perm | undefined): boolean {
  if (cred.euid === 0 || ((dir.mode ?? 0) & S_ISVTX) === 0) return true;
  return cred.euid === dir.uid || cred.euid === (entry ?? dir).uid;
}

export async function ancestryOf(fs: KernelFs, path: string): Promise<Array<Perm | undefined>> {
  if (fs.ancestry) return fs.ancestry(path);
  const out: Array<Perm | undefined> = [];
  for (const at of chain(path)) {
    const st = await fs.lstat(at).catch(() => undefined);
    if (!st) break;
    out.push(permOf(st, st.isSymbolicLink ? await fs.readlink(at) : undefined));
  }
  return out;
}

class Perms {
  private readonly known = new Map<string, Perm | undefined>();
  private readonly fs: KernelFs;

  constructor(fs: KernelFs) {
    this.fs = fs;
  }

  async learn(path: string): Promise<void> {
    const names = chain(path);
    const perms = await ancestryOf(this.fs, path);
    for (let i = 0; i < names.length; i++) {
      const perm = perms[i];
      this.known.set(names[i] as string, perm);
      if (perm === undefined || perm.link !== undefined) break;
    }
  }

  async at(path: string): Promise<Perm | undefined> {
    if (!this.known.has(path)) await this.learn(path);
    return this.known.get(path);
  }
}

function parts(path: string): string[] {
  return path.split('/').filter((part) => part !== '' && part !== '.');
}

export async function walk(
  fs: KernelFs,
  cred: Readonly<Cred>,
  path: string,
  follow: boolean
): Promise<Walked> {
  const perms = new Perms(fs);
  await perms.learn(path);
  const queue = parts(path);
  let at = '/';
  for (let hops = 0; queue.length > 0; ) {
    const part = queue.shift() as string;
    const dir = await perms.at(at);
    if (!dir) return { path: joinName(at, [part, ...queue].join('/')), perm: undefined };
    if (!permits(cred, dir, X_OK)) return { path, perm: undefined, denied: at };
    if (part === '..') {
      at = parentOf(at);
      continue;
    }
    const next = joinName(at, part);
    const perm = await perms.at(next);
    const last = queue.length === 0;
    if (perm?.link !== undefined && (!last || follow)) {
      if (++hops > MAX_LINKS) return { path: next, perm: undefined };
      queue.unshift(...parts(perm.link));
      if (perm.link.startsWith('/')) at = '/';
      continue;
    }
    if (last) return { path: next, perm };
    at = next;
  }
  return { path: at, perm: await perms.at(at) };
}

export async function present(fs: KernelFs, path: string, directory: boolean): Promise<boolean> {
  const st = await fs.lstat(path).catch(() => undefined);
  return st !== undefined && (!directory || st.isDirectory);
}

export interface AccessOptions {
  follow?: boolean;
  directory?: boolean;
}

export async function access(
  fs: KernelFs,
  cred: Readonly<Cred>,
  path: string,
  want: number,
  options: AccessOptions = {}
): Promise<Walked> {
  const walked = await walk(fs, cred, path, options.follow !== false);
  if (walked.denied !== undefined) {
    if (await present(fs, walked.denied, true)) return walked;
    return { path, perm: undefined, missing: true };
  }
  const { perm } = walked;
  if (!perm) return { ...walked, missing: true };
  if (want === 0 || permits(cred, perm, want, options.directory !== false)) return walked;
  if (await present(fs, walked.path, false)) return { ...walked, denied: walked.path };
  return { ...walked, missing: true };
}

export function refused(path: string, errno = 'EACCES'): Error & { code: string } {
  return fsError(errno, path);
}
