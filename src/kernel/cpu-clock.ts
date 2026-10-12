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

export const SYS_CAP_US = 20_000;

const LOCAL = SAB_CLOCK_OFFSET;
const SEQ_TRIES = 64;
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
  let idle = 0;
  let since = 0;
  for (let tries = 0; tries < SEQ_TRIES; tries++) {
    const seq = Atomics.load(clock, SEQ);
    idle = Number(Atomics.load(clock, IDLE));
    since = Number(Atomics.load(clock, SINCE));
    if (seq % 2n === 0n && Atomics.load(clock, SEQ) === seq) {
      return { idle: idle + (since > 0 ? Math.max(0, now - since) : 0), waiting: since > 0 };
    }
  }
  return { idle, waiting: false };
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

  private frozen: number | undefined;

  freeze(): void {
    this.frozen ??= this.now();
  }

  running(): boolean {
    if (this.frozen !== undefined) return false;
    const now = this.now();
    const busy = this.since === 0 || (this.kind === 'sys' && now - this.since < SYS_CAP_US);
    return busy && !localIdle(this.sab, now).waiting;
  }

  times(): CpuTimes {
    const now = this.frozen ?? this.now();
    const open = this.since === 0 ? 0 : Math.max(0, now - this.since);
    const busy = this.kind === 'sys' ? Math.min(open, SYS_CAP_US) : 0;
    const sys = this.sys + busy;
    const idle = this.idle + (open - busy) + localIdle(this.sab, now).idle;
    const user = Math.max(0, now - this.start - sys - idle);
    this.last = {
      utime: Math.max(this.last.utime, Math.floor(user / 1000)),
      stime: Math.max(this.last.stime, Math.floor(sys / 1000)),
    };
    return this.last;
  }

  private add(micros: number): void {
    const spent = Math.max(0, micros);
    const busy = this.kind === 'sys' ? Math.min(spent, SYS_CAP_US) : 0;
    this.sys += busy;
    this.idle += spent - busy;
  }
}

export class ProcessClocks {
  private readonly main: CpuClock;
  private readonly threads = new Map<number, CpuClock>();
  private readonly ended: CpuTimes = { utime: 0, stime: 0 };
  private readonly enabled: boolean;

  constructor(
    sab: SharedArrayBuffer,
    enabled = true,
    states?: { onState(listener: (state: string) => void): void }
  ) {
    this.main = new CpuClock(sab);
    this.enabled = enabled;
    states?.onState((state) => this.stop(state === 'stopped'));
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

  freeze(): void {
    for (const c of this.all()) c.freeze();
  }

  times(): CpuTimes | undefined {
    if (!this.enabled) return undefined;
    const sum = { ...this.ended };
    for (const c of this.all()) {
      const t = c.times();
      sum.utime += t.utime;
      sum.stime += t.stime;
    }
    return sum;
  }

  running(): number {
    return this.enabled ? this.all().filter((c) => c.running()).length : 0;
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
