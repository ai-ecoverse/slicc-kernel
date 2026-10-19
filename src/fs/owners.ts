import type { Cred } from '../kernel/cred.ts';
import type { MetaEntry } from './meta.ts';
import { fsError, type KernelFs, type NewOwner, type Owner } from './types.ts';

export const ROOT_OWNER: Readonly<Owner> = Object.freeze({ uid: 0, gid: 0 });

const S_ISUID = 0o4000;
const S_ISGID = 0o2000;
const S_IXGRP = 0o010;

export function ownOf(entry: MetaEntry | undefined): Owner | undefined {
  if (entry?.uid === undefined || entry.gid === undefined) return undefined;
  return { uid: entry.uid, gid: entry.gid };
}

export function handedBy(entry: MetaEntry | undefined): Owner | undefined {
  return entry?.heir ? { uid: entry.heir[0], gid: entry.heir[1] } : ownOf(entry);
}

export function inherit(entries: ReadonlyArray<MetaEntry | undefined>): Owner {
  for (let i = entries.length - 1; i >= 0; i--) {
    const found = handedBy(entries[i]);
    if (found) return found;
  }
  return { ...ROOT_OWNER };
}

export function chain(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
}

export function sameOwner(a: Owner, b: Owner): boolean {
  return a.uid === b.uid && a.gid === b.gid;
}

export function ownerOf(cred: Readonly<Cred>, mode?: number): NewOwner {
  return { uid: cred.euid, gid: cred.egid, ...(mode !== undefined ? { mode } : {}) };
}

export function inGroup(cred: Readonly<Cred>, gid: number): boolean {
  return cred.egid === gid || cred.groups.includes(gid);
}

export function mayChown(
  cred: Readonly<Cred>,
  current: Owner,
  uid: number | undefined,
  gid: number | undefined
): boolean {
  if (cred.euid === 0) return true;
  const owner = cred.euid === current.uid;
  if (uid !== undefined && !(owner && uid === current.uid)) return false;
  if (gid !== undefined && !(owner && (gid === current.gid || inGroup(cred, gid)))) return false;
  return true;
}

export function clearedSetId(mode: number): number {
  const bits = S_ISUID | (mode & S_IXGRP ? S_ISGID : 0);
  return mode & 0o7777 & ~bits;
}

export async function chownAs(
  fs: KernelFs,
  cred: Readonly<Cred>,
  path: string,
  change: { uid?: number; gid?: number; follow: boolean }
): Promise<void> {
  const { uid, gid, follow } = change;
  const st = follow ? await fs.stat(path) : await fs.lstat(path);
  const current = { uid: st.uid ?? 0, gid: st.gid ?? 0 };
  if (!fs.chown || !mayChown(cred, current, uid, gid)) throw fsError('EPERM', path);
  const clear =
    st.isFile && (uid !== undefined || gid !== undefined) ? clearedSetId(st.mode) : undefined;
  await fs.chown(path, {
    ...(uid !== undefined ? { uid } : {}),
    ...(gid !== undefined ? { gid } : {}),
    follow,
    ...(clear !== undefined && clear !== (st.mode & 0o7777) ? { mode: clear } : {}),
  });
}
