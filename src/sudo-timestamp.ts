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

export type BoundHashes = Readonly<Record<string, string>>;

interface Stamp {
  at: number;
  covered: Set<string>;
}

export function timestampKey(owner: TimestampOwner, type: TimestampType): string | undefined {
  if (type === 'global') return 'global';
  const { terminal, parent } = owner;
  if (type === 'tty' && terminal) {
    return JSON.stringify(['tty', terminal.tty, terminal.sid, terminal.started]);
  }
  return parent ? JSON.stringify(['ppid', parent.pid, parent.started]) : undefined;
}

function boundKey(bound: BoundHashes): string {
  return JSON.stringify(
    Object.keys(bound)
      .sort()
      .map((path) => [path, bound[path]])
  );
}

function writable(bound: BoundHashes | undefined): boolean {
  return bound !== undefined && Object.keys(bound).length > 0;
}

export class Timestamps {
  private readonly users = new Map<number, Map<string, Stamp>>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  current(owner: TimestampOwner, policy: TimestampPolicy, bound?: BoundHashes): boolean {
    if (policy.minutes === 0) return false;
    const key = timestampKey(owner, policy.type);
    const stamp = key === undefined ? undefined : this.users.get(owner.uid)?.get(key);
    if (stamp === undefined) return false;
    const now = this.now();
    if (!(stamp.at <= now && (policy.minutes < 0 || now - stamp.at < policy.minutes * MINUTE_MS))) {
      return false;
    }
    if (!writable(bound)) return true;
    return stamp.covered.has(boundKey(bound as BoundHashes));
  }

  stamp(owner: TimestampOwner, policy: TimestampPolicy, bound?: BoundHashes): boolean {
    const key = policy.minutes === 0 ? undefined : timestampKey(owner, policy.type);
    if (key === undefined) return false;
    const now = this.now();
    const records = this.users.get(owner.uid) ?? new Map<string, Stamp>();
    this.users.set(owner.uid, records);
    const prior = records.get(key);
    const covered = prior?.covered ?? new Set<string>();
    if (writable(bound)) covered.add(boundKey(bound as BoundHashes));
    records.delete(key);
    records.set(key, { at: now, covered });
    for (const [old, stamp] of records) {
      const stale =
        policy.minutes > 0 && (stamp.at > now || now - stamp.at >= policy.minutes * MINUTE_MS);
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
