import { fsError } from '../fs/types.ts';

export interface Cred {
  ruid: number;
  euid: number;
  suid: number;
  rgid: number;
  egid: number;
  sgid: number;
  groups: number[];
}

export type CredChange = Partial<Cred>;

export const ROOT: Readonly<Cred> = Object.freeze({
  ruid: 0,
  euid: 0,
  suid: 0,
  rgid: 0,
  egid: 0,
  sgid: 0,
  groups: [0],
});

const MAX_ID = 0xfffffffe;
const MAX_GROUPS = 65536;
const UIDS = ['ruid', 'euid', 'suid'] as const;
const GIDS = ['rgid', 'egid', 'sgid'] as const;

export function userCred(uid: number, gid: number, groups: number[] = [gid]): Cred {
  return { ruid: uid, euid: uid, suid: uid, rgid: gid, egid: gid, sgid: gid, groups: [...groups] };
}

export function copyCred(cred: Readonly<Cred>): Cred {
  return { ...cred, groups: [...cred.groups] };
}

function id(value: unknown): number | undefined {
  if (value === undefined || value === -1 || value === 0xffffffff) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_ID) {
    throw fsError('EINVAL', `not a user or group id: ${String(value)}`);
  }
  return value as number;
}

export function changeCred(cur: Readonly<Cred>, change: CredChange): Cred {
  const privileged = cur.euid === 0;
  const next = copyCred(cur);
  for (const keys of [UIDS, GIDS]) {
    const own = keys.map((key) => cur[key]);
    for (const key of keys) {
      const value = id(change[key]);
      if (value === undefined) continue;
      if (!privileged && !own.includes(value)) throw fsError('EPERM', `${key} ${value}`);
      next[key] = value;
    }
  }
  if (change.groups !== undefined) {
    if (!Array.isArray(change.groups) || change.groups.length > MAX_GROUPS) {
      throw fsError('EINVAL', 'not a group list');
    }
    const groups = change.groups.map((g) => id(g) ?? Number.NaN);
    if (groups.some(Number.isNaN)) throw fsError('EINVAL', 'not a group list');
    if (!privileged) throw fsError('EPERM', 'setgroups');
    next.groups = groups;
  }
  return next;
}

export function maySignal(sender: Readonly<Cred>, target: Readonly<Cred>): boolean {
  if (sender.euid === 0) return true;
  return [sender.ruid, sender.euid].some((uid) => uid === target.ruid || uid === target.suid);
}

export function maySee(viewer: Readonly<Cred>, target: Readonly<Cred>): boolean {
  return viewer.euid === 0 || target.ruid === viewer.euid || target.euid === viewer.euid;
}
