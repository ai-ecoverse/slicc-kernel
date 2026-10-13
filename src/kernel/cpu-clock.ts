import { SAB_CLOCK_I64, SAB_CLOCK_OFFSET } from '../realm/sync-sab-wire.ts';

export const IDLE_OPS: ReadonlySet<string> = new Set([
  'fd-select',
  'proc-wait',
  'proc-exec',
  'sig-pause',
  'sock-accept',
  'sock-connect',
]);

export const SYS_CAP_US = 20_000;

const LOCAL = SAB_CLOCK_OFFSET;
const BLOCKED = 0;
const IDLE = 1;

export function epochMicros(): number {
  return Math.floor((performance.timeOrigin + performance.now()) * 1000);
}

function slots(sab: SharedArrayBuffer): BigInt64Array {
  return new BigInt64Array(sab, LOCAL, SAB_CLOCK_I64);
}

let local: BigInt64Array | undefined;
let localSab: SharedArrayBuffer | undefined;
let localStart = 0;

export const rawWait: (
  typed: Int32Array,
  index: number,
  value: number,
  timeout?: number
) => 'ok' | 'not-equal' | 'timed-out' = Atomics.wait.bind(Atomics);

export function useLocalClock(sab: SharedArrayBuffer | undefined): void {
  local = sab && sab.byteLength >= LOCAL + SAB_CLOCK_I64 * 8 ? slots(sab) : undefined;
  if (!local) return;
  localSab = sab;
  localStart = epochMicros();
  const wait = (typed: Int32Array, index: number, value: number, timeout?: number) =>
    localWait(() => rawWait(typed, index, value, timeout));
  (Atomics as unknown as { wait: typeof wait }).wait = wait;
}

export function localWait<T>(wait: () => T): T {
  const clock = local;
  if (!clock) return wait();
  const start = BigInt(epochMicros());
  const idle = Atomics.load(clock, IDLE);
  Atomics.store(clock, IDLE, idle - start);
  try {
    return wait();
  } finally {
    const end = BigInt(epochMicros());
    Atomics.store(clock, IDLE, idle + (end > start ? end - start : 0n));
  }
}

export function localCpuNanos(): bigint | undefined {
  if (!local || !localSab) return undefined;
  const now = epochMicros();
  const blocked = Number(Atomics.load(local, BLOCKED)) + localIdle(localSab, now).idle;
  return BigInt(Math.max(0, now - localStart - blocked)) * 1000n;
}

export function localIdle(sab: SharedArrayBuffer, now: number): { idle: number; waiting: boolean } {
  const state = Number(Atomics.load(slots(sab), IDLE));
  if (state >= 0) return { idle: state, waiting: false };
  return { idle: Math.max(0, now + state), waiting: true };
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
    this.add((this.frozen ?? this.now()) - this.since);
    this.since = 0;
  }

  stop(stopped: boolean): void {
    if (stopped === this.stopped) return;
    this.stopped = stopped;
    if (this.since === 0 || !stopped || this.frozen !== undefined) return;
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
    Atomics.store(slots(this.sab), BLOCKED, BigInt(this.idle));
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
