import { KernelError } from './fd-table.ts';

export type LockKind = 'read' | 'write';

export interface RecordLock {
  owner: number;
  kind: LockKind;
  start: number;
  end: number;
}

interface Blocked {
  key: string;
  kind: LockKind;
  start: number;
  end: number;
}

interface Holder {
  exclusive: boolean;
  fds: Set<number>;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

const clashes = (lock: RecordLock, owner: number, want: Blocked) =>
  lock.owner !== owner && overlaps(lock, want) && (lock.kind === 'write' || want.kind === 'write');

export function lockRange(start: number, len: number): { start: number; end: number } {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(len)) throw new KernelError('EINVAL');
  const from = len < 0 ? start + len : start;
  const end = len === 0 ? Number.POSITIVE_INFINITY : len < 0 ? start : start + len;
  if (from < 0) throw new KernelError('EINVAL');
  return { start: from, end };
}

function changedAt(
  wakers: Map<string, Set<() => void>>,
  key: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const set = wakers.get(key) ?? new Set<() => void>();
    wakers.set(key, set);
    const done = () => {
      set.delete(wake);
      if (set.size === 0 && wakers.get(key) === set) wakers.delete(key);
      signal.removeEventListener('abort', abort);
    };
    const wake = () => {
      done();
      resolve();
    };
    const abort = () => {
      done();
      reject(new KernelError('EINTR'));
    };
    set.add(wake);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function wakeAt(wakers: Map<string, Set<() => void>>, key: string): void {
  for (const wake of [...(wakers.get(key) ?? [])]) wake();
}

export type FlockKind = 'shared' | 'exclusive';

export class FlockTable {
  private readonly held = new Map<string, Map<object, FlockKind>>();
  private readonly keys = new WeakMap<object, string>();
  private readonly wakers = new Map<string, Set<() => void>>();

  private free(key: string, owner: object, kind: FlockKind): boolean {
    for (const [other, has] of this.held.get(key) ?? [])
      if (other !== owner && (kind === 'exclusive' || has === 'exclusive')) return false;
    return true;
  }

  set(key: string, owner: object, kind: FlockKind | 'unlock'): boolean {
    const has = this.held.get(key)?.get(owner);
    if (has === kind) return true;
    if (has !== undefined) this.drop(owner);
    if (kind === 'unlock') return true;
    if (!this.free(key, owner, kind)) return false;
    const holders = this.held.get(key) ?? new Map<object, FlockKind>();
    holders.set(owner, kind);
    this.held.set(key, holders);
    this.keys.set(owner, key);
    return true;
  }

  async wait(
    key: string,
    owner: object,
    kind: FlockKind,
    blocking: () => AbortSignal
  ): Promise<void> {
    if (this.set(key, owner, kind)) return;
    const signal = blocking();
    while (!this.set(key, owner, kind)) {
      if (signal.aborted) throw new KernelError('EINTR');
      await changedAt(this.wakers, key, signal);
    }
  }

  drop(owner: object): void {
    const key = this.keys.get(owner);
    if (key === undefined) return;
    this.keys.delete(owner);
    const holders = this.held.get(key);
    holders?.delete(owner);
    if (holders?.size === 0) this.held.delete(key);
    wakeAt(this.wakers, key);
  }
}

export class LockTable {
  readonly flocks = new FlockTable();
  private readonly records = new Map<string, RecordLock[]>();
  private readonly blocked = new Map<number, Blocked>();
  private readonly wakers = new Map<string, Set<() => void>>();
  private readonly held = new Map<string, Map<number, Holder>>();

  holder(key: string, owner: number, want: Blocked): RecordLock | undefined {
    return this.records.get(key)?.find((lock) => clashes(lock, owner, want));
  }

  set(key: string, owner: number, kind: LockKind | 'unlock', start: number, end: number): boolean {
    if (kind !== 'unlock' && this.holder(key, owner, { key, kind, start, end })) return false;
    const range = { start, end };
    const kept: RecordLock[] = [];
    for (const lock of this.records.get(key) ?? []) {
      if (lock.owner !== owner || !overlaps(lock, range)) kept.push(lock);
      else {
        if (lock.start < start) kept.push({ ...lock, end: start });
        if (lock.end > end) kept.push({ ...lock, start: end });
      }
    }
    if (kind !== 'unlock') kept.push({ owner, kind, start, end });
    this.store(key, merged(kept));
    this.wake(key);
    return true;
  }

  async wait(
    key: string,
    owner: number,
    kind: LockKind,
    range: { start: number; end: number },
    blocking: () => AbortSignal
  ): Promise<void> {
    const want = { key, kind, ...range };
    let signal: AbortSignal | undefined;
    for (;;) {
      const holder = this.holder(key, owner, want);
      if (!holder) {
        this.set(key, owner, kind, range.start, range.end);
        return;
      }
      if (this.waitsOn(holder.owner, owner)) throw new KernelError('EDEADLK');
      signal ??= blocking();
      if (signal.aborted) throw new KernelError('EINTR');
      this.blocked.set(owner, want);
      try {
        await this.changed(key, signal);
      } finally {
        this.blocked.delete(owner);
      }
    }
  }

  private waitsOn(from: number, target: number): boolean {
    const seen = new Set<number>();
    for (let at: number | undefined = from; at !== undefined && !seen.has(at); ) {
      seen.add(at);
      const want = this.blocked.get(at);
      if (!want) return false;
      const holder = this.holder(want.key, at, want);
      if (!holder) return false;
      if (holder.owner === target) return true;
      at = holder.owner;
    }
    return false;
  }

  private changed(key: string, signal: AbortSignal): Promise<void> {
    return changedAt(this.wakers, key, signal);
  }

  private wake(key: string): void {
    wakeAt(this.wakers, key);
  }

  private store(key: string, locks: RecordLock[]): void {
    if (locks.length === 0) this.records.delete(key);
    else this.records.set(key, locks);
  }

  holds(owner: number): boolean {
    for (const locks of this.records.values())
      if (locks.some((l) => l.owner === owner)) return true;
    return false;
  }

  dropFile(key: string, owner: number): void {
    const locks = this.records.get(key);
    if (!locks?.some((l) => l.owner === owner)) return;
    this.store(
      key,
      locks.filter((l) => l.owner !== owner)
    );
    this.wake(key);
  }

  lock(pid: number, path: string, exclusive: boolean, fd: number): boolean {
    const holders = this.held.get(path) ?? new Map<number, Holder>();
    for (const [other, h] of holders) if (other !== pid && (exclusive || h.exclusive)) return false;
    const mine = holders.get(pid) ?? { exclusive, fds: new Set<number>() };
    mine.exclusive = exclusive;
    mine.fds.add(fd);
    holders.set(pid, mine);
    this.held.set(path, holders);
    return true;
  }

  unlock(pid: number, path: string): void {
    const holders = this.held.get(path);
    holders?.delete(pid);
    if (holders?.size === 0) this.held.delete(path);
  }

  closed(pid: number, fd: number): void {
    for (const [path, holders] of [...this.held]) {
      const mine = holders.get(pid);
      if (mine?.fds.delete(fd) && mine.fds.size === 0) this.unlock(pid, path);
    }
  }

  release(pid: number): void {
    for (const path of [...this.held.keys()]) this.unlock(pid, path);
    for (const key of [...this.records.keys()]) this.dropFile(key, pid);
  }
}

function merged(locks: RecordLock[]): RecordLock[] {
  const sorted = [...locks].sort((a, b) => a.owner - b.owner || a.start - b.start);
  const out: RecordLock[] = [];
  for (const lock of sorted) {
    const last = out[out.length - 1];
    if (last && last.owner === lock.owner && last.kind === lock.kind && last.end >= lock.start) {
      last.end = Math.max(last.end, lock.end);
    } else out.push({ ...lock });
  }
  return out;
}
