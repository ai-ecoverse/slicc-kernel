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
import type { KernelFs, Perm } from './types.ts';
import { joinName, parentOf } from './walk.ts';

export interface Denial {
  pid: number;
  uid: number;
  op: string;
  path: string;
  errno: string;
}

export type DenialHook = (denial: Denial) => void;

export const MAX_DENIAL_KEYS = 10_000;

const S_ISGID = 0o2000;

export class Dac {
  readonly mode: 'report' | 'enforce';
  private readonly hook: DenialHook | undefined;
  private readonly log: (line: string) => void;
  private readonly seen = new Set<string>();
  private suppressed = false;

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

  denied(denial: Denial): void {
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
      `slicc-kernel users report: ${d.errno} ${d.op} ${d.path} (uid ${d.uid}, pid ${d.pid})`
    );
  }
}

export interface Guard {
  fs: KernelFs;
  cred: Readonly<Cred>;
  pid: number;
  dac: Dac;
}

export function deny(g: Guard, op: string, path: string, errno = 'EACCES'): void {
  g.dac.denied({ pid: g.pid, uid: g.cred.euid, op, path, errno });
}

export async function need(
  g: Guard,
  op: string,
  path: string,
  want: number,
  options: AccessOptions = {},
  shown = path
): Promise<Walked> {
  const walked = await access(g.fs, g.cred, path, want, options);
  if (walked.denied !== undefined) deny(g, op, shown);
  return walked;
}

async function stickyEntry(g: Guard, op: string, path: string, dir: Walked): Promise<void> {
  const perm = dir.perm;
  if (!perm || sticky(g.cred, perm, perm)) return;
  const entry = joinName(dir.path, path.slice(path.lastIndexOf('/') + 1));
  if (sticky(g.cred, perm, (await ancestryOf(g.fs, entry)).at(-1))) return;
  if (await present(g.fs, entry, false)) deny(g, op, path, 'EPERM');
}

export async function inParent(g: Guard, op: string, path: string, old = false): Promise<void> {
  const dir = await need(g, op, parentOf(path), W_OK | X_OK, {}, path);
  if (old && dir.denied === undefined) await stickyEntry(g, op, path, dir);
}

export async function makeIn(g: Guard, op: string, path: string): Promise<void> {
  for (let dir = parentOf(path); ; dir = parentOf(dir)) {
    const walked = await access(g.fs, g.cred, dir, W_OK | X_OK);
    if (walked.denied !== undefined) {
      if (!(await present(g.fs, path, true))) deny(g, op, path);
      return;
    }
    if (!walked.missing || dir === '/') return;
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
  await inParent(g, 'rename', to, true);
  if (g.cred.euid === 0 || parentOf(from) === parentOf(to)) return;
  const st = await g.fs.lstat(from).catch(() => undefined);
  if (st?.isDirectory && !permits(g.cred, permOf(st), W_OK)) deny(g, 'rename', from);
}

export async function linkable(g: Guard, from: string, to: string, follow: boolean) {
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

export async function retimable(g: Guard, op: string, path: string): Promise<void> {
  await ownerOnly(g, op, path, op !== 'lutimes');
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
  const st = await g.fs.stat(path).catch(() => undefined);
  if (st) return void (await need(g, op, path, W_OK, { directory: st.isDirectory }));
  const target = await need(g, op, path, 0);
  if (target.denied === undefined) await need(g, op, parentOf(target.path), W_OK | X_OK, {}, path);
}
