import type { Cred } from '../kernel/cred.ts';
import {
  type AccessOptions,
  access,
  ancestryOf,
  permits,
  permOf,
  present,
  R_OK,
  refused,
  sticky,
  W_OK,
  type Walked,
  X_OK,
} from './access.ts';
import { inGroup } from './owners.ts';
import { type FsStat, type KernelFs, normalizePath, type Perm } from './types.ts';
import { joinName, parentOf } from './walk.ts';

export interface Denial {
  pid: number;
  uid: number;
  op: string;
  path: string;
  errno: string;
  tag?: string;
  expected?: string;
  actual?: string;
}

export type DenialHook = (denial: Denial) => void;

export const MAX_DENIAL_KEYS = 10_000;

const S_ISGID = 0o2000;
const DIR = { directory: true } as const;

export class Dac {
  readonly mode: 'report' | 'enforce';
  private readonly hook: DenialHook | undefined;
  private readonly log: (line: string) => void;
  private readonly seen = new Set<string>();
  private suppressed = false;
  tagOf: (pid: number) => string | undefined = () => undefined;
  fenced: (pid: number, path: string) => boolean = () => false;

  constructor(
    mode: 'report' | 'enforce',
    hook?: DenialHook,
    log: (line: string) => void = (line) => console.warn(line)
  ) {
    this.mode = mode;
    this.hook = hook;
    this.log = log;
  }

  get enforcing(): boolean {
    return this.mode === 'enforce';
  }

  fence(denial: Denial): never {
    try {
      this.hook?.({ ...denial });
    } catch {}
    throw refused(denial.path, denial.errno);
  }

  denied(given: Denial): void {
    const tag = given.tag ?? (given.pid ? this.tagOf(given.pid) : undefined);
    const denial = tag === undefined ? given : { ...given, tag };
    try {
      this.hook?.({ ...denial });
    } catch {}
    if (this.mode === 'report') this.note(denial);
    else throw refused(denial.path, denial.errno);
  }

  private note(d: Denial): void {
    const key = `${d.uid}\0${d.op}\0${d.errno}\0${d.path}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= MAX_DENIAL_KEYS) {
      if (!this.suppressed) this.log('slicc-kernel users report: more denials suppressed');
      this.suppressed = true;
      return;
    }
    this.seen.add(key);
    this.log(
      `slicc-kernel users report: ${d.errno} ${d.op} ${d.path} (uid ${d.uid}, pid ${d.pid}${d.tag === undefined ? '' : `, tag ${d.tag}`})`
    );
  }
}

const MAX_CREATED = 1024;

export class Created {
  private readonly paths = new Set<string>();

  add(path: string): void {
    if (this.paths.size >= MAX_CREATED) this.paths.clear();
    this.paths.add(normalizePath(path));
  }

  take(path: string): boolean {
    return this.paths.delete(normalizePath(path));
  }
}

export interface Guard {
  fs: KernelFs;
  cred: Readonly<Cred>;
  pid: number;
  dac: Dac;
  tag?: string | undefined;
  links?: number | undefined;
}

function linked(g: Guard, options: AccessOptions): AccessOptions {
  return g.links === undefined ? options : { ...options, links: g.links };
}

export function deny(g: Guard, op: string, path: string, errno = 'EACCES'): void {
  const tag = g.tag === undefined ? {} : { tag: g.tag };
  g.dac.denied({ pid: g.pid, uid: g.cred.euid, op, path, errno, ...tag });
}

const FENCE_HOPS = 40;

async function entryAt(g: Guard, path: string): Promise<string> {
  const parent = parentOf(path);
  const real = await g.fs.realpath?.(parent, true).catch(() => undefined);
  return real ? joinName(real, path.slice(path.lastIndexOf('/') + 1)) : path;
}

async function fencedNames(g: Guard, path: string): Promise<string[]> {
  const names = [normalizePath(path)];
  let at = await entryAt(g, names[0] as string);
  for (let hop = 0; hop < FENCE_HOPS; hop++) {
    names.push(at);
    const link = await g.fs.readlink(at).catch(() => undefined);
    if (link === undefined) break;
    at = await entryAt(g, normalizePath(g.fs.resolvePath(parentOf(at), link)));
  }
  return names;
}

async function fence(g: Guard, op: string, path: string): Promise<void> {
  if (!g.pid || !g.dac.fenced(g.pid, '/')) return;
  const names = await fencedNames(g, path);
  if (!names.some((name) => g.dac.fenced(g.pid, name))) return;
  const tag = g.tag === undefined ? {} : { tag: g.tag };
  g.dac.fence({ pid: g.pid, uid: g.cred.euid, op, path, errno: 'EACCES', ...tag });
}

export const TTY_MODE = 0o620;

export function ttyOpenable(g: Guard | undefined, tty: { name?: string; owner?: Perm }): void {
  if (!g || !tty.owner || permits(g.cred, tty.owner, R_OK | W_OK, false)) return;
  deny(g, 'open', tty.name ?? '/dev/tty');
}

export async function need(
  g: Guard,
  op: string,
  path: string,
  want: number,
  options: AccessOptions = {},
  shown = path
): Promise<Walked> {
  if (want & W_OK && shown === path) await fence(g, op, path);
  const walked = await access(g.fs, g.cred, path, want, linked(g, options));
  if (walked.denied !== undefined) deny(g, op, walked.link ? walked.denied : shown);
  else if (want & R_OK && g.fs.commandTarget) await readsAs(g, op, walked.path, shown);
  return walked;
}

async function readsAs(g: Guard, op: string, path: string, shown: string): Promise<void> {
  const target = await g.fs.commandTarget?.(path);
  if (target !== undefined) await need(g, op, target, R_OK, { directory: false }, shown);
}

function entryIn(dir: Walked, path: string): string {
  return joinName(dir.path, path.slice(path.lastIndexOf('/') + 1));
}

async function stickyEntry(g: Guard, op: string, path: string, dir: Walked): Promise<void> {
  const perm = dir.perm;
  if (!perm || sticky(g.cred, perm, perm)) return;
  const entry = entryIn(dir, path);
  if (sticky(g.cred, perm, (await ancestryOf(g.fs, entry)).at(-1))) return;
  if (await present(g.fs, entry, false)) deny(g, op, path, 'EPERM');
}

async function unwritable(g: Guard, op: string, path: string, dir: Walked): Promise<boolean> {
  if (dir.denied === undefined) return false;
  if (dir.link) {
    deny(g, op, dir.denied);
    return false;
  }
  const perm = dir.denied === dir.path ? dir.perm : undefined;
  if (perm && !(await present(g.fs, dir.path, true))) return false;
  if (perm && permits(g.cred, perm, X_OK)) return true;
  deny(g, op, path);
  return false;
}

export async function inParent(
  g: Guard,
  op: string,
  path: string,
  old: boolean | 'replaced' = false
): Promise<void> {
  await fence(g, op, path);
  const dir = await access(g.fs, g.cred, parentOf(path), W_OK | X_OK, linked(g, DIR));
  if (old !== true) {
    if (await unwritable(g, op, path, dir)) deny(g, op, path);
    else if (old === 'replaced' && dir.denied === undefined) await stickyEntry(g, op, path, dir);
    return;
  }
  if (dir.denied === undefined) return stickyEntry(g, op, path, dir);
  if (dir.link) return deny(g, op, dir.denied);
  const lookup = dir.denied === dir.path && dir.perm && permits(g.cred, dir.perm, X_OK);
  if (!lookup || (await present(g.fs, entryIn(dir, path), false))) deny(g, op, path);
}

export async function makeIn(g: Guard, op: string, path: string, parents = true): Promise<void> {
  for (let dir = parentOf(path); ; dir = parentOf(dir)) {
    const walked = await access(g.fs, g.cred, dir, W_OK | X_OK, linked(g, DIR));
    if (await unwritable(g, op, path, walked)) {
      if (!(await present(g.fs, path, true))) deny(g, op, path);
      return;
    }
    if (!parents || !walked.missing || dir === '/') return;
  }
}

async function tree(g: Guard, op: string, dir: string, perm: Perm): Promise<void> {
  if (!permits(g.cred, perm, R_OK | W_OK | X_OK)) return deny(g, op, dir);
  for (const [name, st] of await g.fs.readdirStat(dir)) {
    if (!st) continue;
    const child = joinName(dir, name);
    if (!sticky(g.cred, perm, permOf(st))) deny(g, op, child, 'EPERM');
    if (st.isDirectory) await tree(g, op, child, permOf(st));
  }
}

export async function removable(g: Guard, op: string, path: string): Promise<void> {
  await inParent(g, op, path, true);
  if (g.cred.euid === 0) return;
  const st = await g.fs.lstat(path).catch(() => undefined);
  if (st?.isDirectory) await tree(g, op, path, permOf(st));
}

export async function renamable(g: Guard, from: string, to: string): Promise<void> {
  if (from === to) return void (await need(g, 'rename', from, 0, { follow: false }));
  await inParent(g, 'rename', from, true);
  await inParent(g, 'rename', to, 'replaced');
  if (g.cred.euid === 0 || parentOf(from) === parentOf(to)) return;
  const st = await g.fs.lstat(from).catch(() => undefined);
  if (st?.isDirectory && !permits(g.cred, permOf(st), W_OK)) deny(g, 'rename', from);
}

export async function linkable(g: Guard, from: string, to: string, follow: boolean) {
  await fence(g, 'link', from);
  const source = await need(g, 'link', from, 0, { follow });
  const perm = source.perm;
  if (perm && g.cred.euid !== 0 && perm.uid !== g.cred.euid) {
    const safe = permits(g.cred, perm, R_OK | W_OK, false);
    if (!safe && (await present(g.fs, source.path, false))) deny(g, 'link', from, 'EPERM');
  }
  await inParent(g, 'link', to);
}

async function ownerOnly(g: Guard, op: string, path: string, follow: boolean) {
  const walked = await need(g, op, path, 0, { follow });
  const perm = walked.perm;
  if (!perm || g.cred.euid === 0 || perm.uid === g.cred.euid) return walked;
  if (await present(g.fs, walked.path, false)) deny(g, op, path, 'EPERM');
  return walked;
}

export async function chmodMode(g: Guard, path: string, mode: number): Promise<number> {
  const perm = (await ownerOnly(g, 'chmod', path, true)).perm;
  if (!g.dac.enforcing || !perm || g.cred.euid === 0 || inGroup(g.cred, perm.gid)) return mode;
  return mode & ~S_ISGID;
}

export function heldChmodMode(g: Guard, path: string, st: FsStat, mode: number): number {
  const perm = permOf(st);
  if (g.cred.euid !== 0 && perm.uid !== g.cred.euid) deny(g, 'fchmod', path, 'EPERM');
  if (!g.dac.enforcing || g.cred.euid === 0 || inGroup(g.cred, perm.gid)) return mode;
  return mode & ~S_ISGID;
}

export function heldRetimable(g: Guard, path: string, st: FsStat, now: boolean): void {
  const perm = permOf(st);
  if (g.cred.euid === 0 || perm.uid === g.cred.euid) return;
  if (!now) deny(g, 'futimens', path, 'EPERM');
  else if (!permits(g.cred, perm, W_OK, false)) deny(g, 'futimens', path);
}

export async function retimable(g: Guard, op: string, path: string, now = false) {
  const follow = op !== 'lutimes';
  if (!now) return void (await ownerOnly(g, op, path, follow));
  const walked = await need(g, op, path, 0, { follow });
  const perm = walked.perm;
  if (!perm || g.cred.euid === 0 || perm.uid === g.cred.euid) return;
  if (permits(g.cred, perm, W_OK, false)) return;
  if (await present(g.fs, walked.path, false)) deny(g, op, path);
}

export async function fileWritable(g: Guard, op: string, path: string): Promise<void> {
  await need(g, op, path, W_OK, { directory: false });
}

export function realIds(cred: Readonly<Cred>): Cred {
  return { ...cred, groups: [...cred.groups], euid: cred.ruid, egid: cred.rgid };
}

export async function listable(g: Guard, op: string, path: string): Promise<void> {
  await need(g, op, path, R_OK | X_OK, { directory: true });
}

export async function searchable(g: Guard, op: string, path: string, follow: boolean) {
  await need(g, op, path, 0, { follow });
}

export async function readable(g: Guard, op: string, path: string): Promise<void> {
  await need(g, op, path, R_OK, { directory: false });
}

export async function writable(g: Guard, op: string, path: string): Promise<void> {
  await openable(g, op, path, W_OK, true);
}

export async function creatable(g: Guard, op: string, path: string): Promise<void> {
  const target = await need(g, op, path, 0);
  if (target.denied === undefined) await need(g, op, parentOf(target.path), W_OK | X_OK, DIR, path);
}

export async function openable(
  g: Guard,
  op: string,
  path: string,
  want: number,
  create: boolean
): Promise<void> {
  const st = create ? await g.fs.stat(path).catch(() => undefined) : undefined;
  if (create && !st) return creatable(g, op, path);
  await need(g, op, path, want, { directory: st?.isDirectory ?? false });
}
