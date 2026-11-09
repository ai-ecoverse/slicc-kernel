import type { TimestampType } from './sudoers.ts';

export const TIMESTAMPS_MAX = 64;
const MINUTE_MS = 60_000;

export interface TimestampOwner {
  uid: number;
  terminal?: { tty: string; sid: number; started: number } | undefined;
  parent?: { pid: number; started: number } | undefined;
}

export interface TimestampPolicy {
  type: TimestampType;
  minutes: number;
}

export function timestampKey(owner: TimestampOwner, type: TimestampType): string | undefined {
  if (type === 'global') return 'global';
  const { terminal, parent } = owner;
  if (type === 'tty' && terminal) {
    return JSON.stringify(['tty', terminal.tty, terminal.sid, terminal.started]);
  }
  return parent ? JSON.stringify(['ppid', parent.pid, parent.started]) : undefined;
}

export class Timestamps {
  private readonly users = new Map<number, Map<string, number>>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  current(owner: TimestampOwner, policy: TimestampPolicy): boolean {
    if (policy.minutes === 0) return false;
    const key = timestampKey(owner, policy.type);
    const at = key === undefined ? undefined : this.users.get(owner.uid)?.get(key);
    if (at === undefined) return false;
    const now = this.now();
    return at <= now && (policy.minutes < 0 || now - at < policy.minutes * MINUTE_MS);
  }

  stamp(owner: TimestampOwner, policy: TimestampPolicy): boolean {
    const key = policy.minutes === 0 ? undefined : timestampKey(owner, policy.type);
    if (key === undefined) return false;
    const now = this.now();
    const records = this.users.get(owner.uid) ?? new Map<string, number>();
    this.users.set(owner.uid, records);
    records.delete(key);
    records.set(key, now);
    for (const [old, at] of records) {
      const stale = policy.minutes > 0 && (at > now || now - at >= policy.minutes * MINUTE_MS);
      if (stale || records.size > TIMESTAMPS_MAX) records.delete(old);
    }
    return true;
  }

  invalidate(owner: TimestampOwner, type: TimestampType): void {
    const key = timestampKey(owner, type);
    const records = this.users.get(owner.uid);
    if (key !== undefined) records?.delete(key);
    if (records?.size === 0) this.users.delete(owner.uid);
  }

  remove(uid: number): void {
    this.users.delete(uid);
  }
}
