import { type Cred, copyCred, maySee } from './cred.ts';

export interface TraceExec {
  type: 'exec';
  seq: number;
  pid: number;
  ppid: number;
  pgid: number;
  argv: string[];
  exe?: string;
  uid: number;
  at: number;
  replaced?: true;
}

export interface TraceFork {
  type: 'fork';
  seq: number;
  pid: number;
  ppid: number;
  pgid: number;
  argv: string[];
  exe?: string;
  uid: number;
  at: number;
}

export interface TraceExit {
  type: 'exit';
  seq: number;
  pid: number;
  status: number;
  signal?: string;
  utime?: number;
  stime?: number;
  at: number;
}

export type TraceEvent = TraceExec | TraceFork | TraceExit;

type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never;
export type TraceDraft = Unsequenced<TraceEvent>;

export interface TraceBatch {
  events: TraceEvent[];
  dropped: number;
}

export const TRACE_LIMIT = 4096;
export const TRACE_LIMIT_MAX = 65_536;

export function traceLimit(value: unknown): number {
  if (value === undefined) return TRACE_LIMIT;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > TRACE_LIMIT_MAX) {
    throw Object.assign(new Error(`a trace limit is an integer from 1 to ${TRACE_LIMIT_MAX}`), {
      code: 'EINVAL',
    });
  }
  return value as number;
}

interface Subscription {
  tag: string;
  viewer: Cred;
  limit: number;
  queue: TraceEvent[];
  dropped: number;
  waiting: boolean;
  scheduled: boolean;
  deliver(batch: TraceBatch): void;
}

export interface TraceSubscription {
  ack(): void;
  close(): void;
}

export class TraceHub {
  private readonly subs = new Set<Subscription>();
  private seq = 0;

  get idle(): boolean {
    return this.subs.size === 0;
  }

  subscribe(
    tag: string,
    viewer: Readonly<Cred>,
    deliver: (batch: TraceBatch) => void,
    limit = TRACE_LIMIT
  ): TraceSubscription {
    const sub: Subscription = {
      tag,
      viewer: copyCred(viewer),
      limit,
      queue: [],
      dropped: 0,
      waiting: false,
      scheduled: false,
      deliver,
    };
    this.subs.add(sub);
    return {
      ack: () => {
        sub.waiting = false;
        this.schedule(sub);
      },
      close: () => {
        this.subs.delete(sub);
        sub.queue = [];
      },
    };
  }

  wants(tags: readonly string[] | undefined, cred: Readonly<Cred>): boolean {
    if (!tags?.length || this.subs.size === 0) return false;
    for (const sub of this.subs) if (this.matches(sub, tags, cred)) return true;
    return false;
  }

  publish(tags: readonly string[] | undefined, cred: Readonly<Cred>, draft: TraceDraft): void {
    if (!tags?.length) return;
    let event: TraceEvent | undefined;
    for (const sub of this.subs) {
      if (!this.matches(sub, tags, cred)) continue;
      event ??= { ...draft, seq: ++this.seq } as TraceEvent;
      if (sub.queue.length >= sub.limit) sub.dropped++;
      else sub.queue.push(event);
      this.schedule(sub);
    }
  }

  private matches(sub: Subscription, tags: readonly string[], cred: Readonly<Cred>): boolean {
    return tags.includes(sub.tag) && maySee(sub.viewer, cred);
  }

  private schedule(sub: Subscription): void {
    if (sub.scheduled || sub.waiting) return;
    if (sub.queue.length === 0 && sub.dropped === 0) return;
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      if (!this.subs.has(sub)) return;
      const batch = { events: sub.queue, dropped: sub.dropped };
      sub.queue = [];
      sub.dropped = 0;
      sub.waiting = true;
      sub.deliver(batch);
    });
  }
}
