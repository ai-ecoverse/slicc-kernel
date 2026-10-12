import { SAB_CLOCK_I64, SAB_CLOCK_OFFSET } from '../realm/sync-sab-wire.ts';

export const IDLE_OPS: ReadonlySet<string> = new Set([
  'fd-read',
  'fd-poll',
  'fd-select',
  'proc-wait',
  'proc-exec',
  'sig-pause',
  'sock-accept',
  'sock-connect',
  'sock-recv',
  'sock-recvfrom',
  'sock-recvmsg',
]);

const LOCAL = SAB_CLOCK_OFFSET;
const SEQ = 0;
const IDLE = 1;
const SINCE = 2;

export function epochMicros(): number {
  return Math.floor((performance.timeOrigin + performance.now()) * 1000);
}

function slots(sab: SharedArrayBuffer): BigInt64Array {
  return new BigInt64Array(sab, LOCAL, SAB_CLOCK_I64);
}

let local: BigInt64Array | undefined;

export const rawWait: (
  typed: Int32Array,
  index: number,
  value: number,
  timeout?: number
) => 'ok' | 'not-equal' | 'timed-out' = Atomics.wait.bind(Atomics);

export function useLocalClock(sab: SharedArrayBuffer | undefined): void {
  local = sab && sab.byteLength >= LOCAL + SAB_CLOCK_I64 * 8 ? slots(sab) : undefined;
  if (!local) return;
  const wait = (typed: Int32Array, index: number, value: number, timeout?: number) =>
    localWait(() => rawWait(typed, index, value, timeout));
  (Atomics as unknown as { wait: typeof wait }).wait = wait;
}

export function localWait<T>(wait: () => T): T {
  const clock = local;
  if (!clock) return wait();
  const start = epochMicros();
  Atomics.store(clock, SINCE, BigInt(start));
  try {
    return wait();
  } finally {
    Atomics.add(clock, SEQ, 1n);
    Atomics.add(clock, IDLE, BigInt(Math.max(0, epochMicros() - start)));
    Atomics.store(clock, SINCE, 0n);
    Atomics.add(clock, SEQ, 1n);
  }
}

export function localIdle(sab: SharedArrayBuffer, now: number): { idle: number; waiting: boolean } {
  const clock = slots(sab);
  for (;;) {
    const seq = Atomics.load(clock, SEQ);
    const idle = Number(Atomics.load(clock, IDLE));
    const since = Number(Atomics.load(clock, SINCE));
    if (seq % 2n !== 0n || Atomics.load(clock, SEQ) !== seq) continue;
    return { idle: idle + (since > 0 ? Math.max(0, now - since) : 0), waiting: since > 0 };
  }
}

export interface CpuTimes {
  utime: number;
  stime: number;
}

export class CpuClock {
  private readonly start: number;
  private sys = 0;
  private idle = 0;
  private since = 0;
  private kind: 'sys' | 'idle' = 'sys';
  private stopped = false;
  private last: CpuTimes = { utime: 0, stime: 0 };
  private readonly sab: SharedArrayBuffer;
  private readonly now: () => number;

  constructor(sab: SharedArrayBuffer, now: () => number = epochMicros) {
    this.sab = sab;
    this.now = now;
    this.start = now();
  }

  enter(op: string): void {
    this.since = this.now();
    this.kind = this.stopped || IDLE_OPS.has(op) ? 'idle' : 'sys';
  }

  leave(): void {
    if (this.since === 0) return;
    this.add(this.now() - this.since);
    this.since = 0;
  }

  stop(stopped: boolean): void {
    if (stopped === this.stopped) return;
    this.stopped = stopped;
    if (this.since === 0 || !stopped) return;
    const now = this.now();
    this.add(now - this.since);
    this.since = now;
    this.kind = 'idle';
  }

  running(): boolean {
    return this.since === 0 && !localIdle(this.sab, this.now()).waiting;
  }

  times(): CpuTimes {
    const now = this.now();
    const open = this.since === 0 ? 0 : Math.max(0, now - this.since);
    const sys = this.sys + (this.kind === 'sys' ? open : 0);
    const idle = this.idle + (this.kind === 'idle' ? open : 0) + localIdle(this.sab, now).idle;
    const user = Math.max(0, now - this.start - sys - idle);
    this.last = {
      utime: Math.max(this.last.utime, Math.floor(user / 1000)),
      stime: Math.max(this.last.stime, Math.floor(sys / 1000)),
    };
    return this.last;
  }

  private add(micros: number): void {
    if (this.kind === 'sys') this.sys += Math.max(0, micros);
    else this.idle += Math.max(0, micros);
  }
}

export class ProcessClocks {
  private readonly main: CpuClock;
  private readonly threads = new Map<number, CpuClock>();
  private readonly ended: CpuTimes = { utime: 0, stime: 0 };

  constructor(sab: SharedArrayBuffer) {
    this.main = new CpuClock(sab);
  }

  thread(tid: number, sab: SharedArrayBuffer): CpuClock {
    const clock = new CpuClock(sab);
    this.threads.set(tid, clock);
    return clock;
  }

  threadEnded(tid: number): void {
    const spent = this.threads.get(tid)?.times();
    this.threads.delete(tid);
    if (!spent) return;
    this.ended.utime += spent.utime;
    this.ended.stime += spent.stime;
  }

  stop(stopped: boolean): void {
    for (const c of this.all()) c.stop(stopped);
  }

  times(): CpuTimes {
    const sum = { ...this.ended };
    for (const c of this.all()) {
      const t = c.times();
      sum.utime += t.utime;
      sum.stime += t.stime;
    }
    return sum;
  }

  running(): number {
    return this.all().filter((c) => c.running()).length;
  }

  timed<R extends { op: string }, T>(
    clock: CpuClock | undefined,
    dispatch: (req: R) => Promise<T>
  ) {
    const c = clock ?? this.main;
    return (req: R): Promise<T> => {
      c.enter(req.op);
      return dispatch(req).finally(() => c.leave());
    };
  }

  private all(): CpuClock[] {
    return [this.main, ...this.threads.values()];
  }
}
