import { E, EVENT_FD_READWRITE_HANGUP, EVENTTYPE, SIZE, SUBCLOCK_ABSTIME } from './wasi-abi.ts';
import type { WasiFds, WasiKernel } from './wasi-fds.ts';
import type { WasiMemory } from './wasi-memory.ts';

interface Subscription {
  userdata: bigint;
  type: number;
  fd: number;

  deadline: number;
}

interface PollEvent {
  userdata: bigint;
  error: number;
  type: number;

  hangup?: boolean;

  nbytes?: number;
}

export type ClockNow = (id: number) => bigint;

function readSubscriptions(mem: WasiMemory, ptr: number, n: number, now: ClockNow): Subscription[] {
  const v = mem.view();
  const at = performance.now();
  const subs: Subscription[] = [];
  for (let i = 0; i < n; i++) {
    const p = ptr + i * SIZE.SUBSCRIPTION;
    const type = v.getUint8(p + 8);
    const sub = { userdata: v.getBigUint64(p, true), type, fd: -1, deadline: Infinity };
    if (type === EVENTTYPE.CLOCK) {
      const id = v.getUint32(p + 16, true);
      let ms = Number(v.getBigUint64(p + 24, true)) / 1e6;
      if (v.getUint16(p + 40, true) & SUBCLOCK_ABSTIME) ms -= Number(now(id)) / 1e6;
      sub.deadline = at + Math.max(0, ms);
    } else {
      sub.fd = v.getUint32(p + 16, true);
    }
    subs.push(sub);
  }
  return subs;
}

function writeEvents(mem: WasiMemory, ptr: number, events: readonly PollEvent[]): void {
  const v = mem.view();
  events.forEach((ev, i) => {
    const p = ptr + i * SIZE.EVENT;
    mem.bytes(p, SIZE.EVENT).fill(0);
    v.setBigUint64(p, ev.userdata, true);
    v.setUint16(p + 8, ev.error, true);
    v.setUint8(p + 10, ev.type);

    if (ev.type !== EVENTTYPE.CLOCK) {
      v.setBigUint64(p + 16, BigInt(ev.nbytes ?? 1), true);
      if (ev.hangup) v.setUint16(p + 24, EVENT_FD_READWRITE_HANGUP, true);
    }
  });
}

function classify(
  fds: WasiFds,
  subs: readonly Subscription[]
): { events: PollEvent[]; read: number[]; write: number[] } {
  const events: PollEvent[] = [];
  const read: number[] = [];
  const write: number[] = [];
  for (const s of subs) {
    if (s.type === EVENTTYPE.CLOCK) continue;
    const e = fds.find(s.fd);
    if (!e) events.push({ userdata: s.userdata, error: E.BADF, type: s.type });
    else if (e.type !== 'kernel')
      events.push({ userdata: s.userdata, error: E.SUCCESS, type: s.type });
    else (s.type === EVENTTYPE.FD_READ ? read : write).push(s.fd);
  }
  return { events, read, write };
}

interface Ready {
  read: number[];
  write: number[];
  hangup?: number[];
  nread?: Record<number, number>;
}

function nbytesOf(s: Subscription, ready: Ready): { nbytes?: number } {
  const n = s.type === EVENTTYPE.FD_READ ? ready.nread?.[s.fd] : undefined;
  return n === undefined ? {} : { nbytes: n };
}

function readyEvents(subs: readonly Subscription[], ready: Ready): PollEvent[] {
  return subs
    .filter(
      (s) =>
        (s.type === EVENTTYPE.FD_READ && ready.read.includes(s.fd)) ||
        (s.type === EVENTTYPE.FD_WRITE && ready.write.includes(s.fd))
    )
    .map((s) => ({
      userdata: s.userdata,
      error: E.SUCCESS,
      type: s.type,
      hangup: ready.hangup?.includes(s.fd) === true,
      ...nbytesOf(s, ready),
    }));
}

interface PollDeps {
  mem: WasiMemory;
  fds: WasiFds;
  kernel: WasiKernel;
  now: ClockNow;

  interruptWakes?: boolean;

  entered?: boolean;

  resumes?: () => boolean;
}

const RESUMES = 64;

function selectOnce(
  deps: PollDeps,
  read: number[],
  write: number[],
  timeoutMs: number,
  mayResume: boolean
): { ready: Ready; interrupted: boolean; resumed?: true } {
  try {
    const ready = deps.kernel.call({ op: 'fd-select', read, write, timeoutMs });
    return { ready: ready as Ready, interrupted: false };
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'EINTR') throw e;
    if (!deps.interruptWakes && mayResume && deps.resumes?.()) {
      return { ready: { read: [], write: [] }, interrupted: false, resumed: true };
    }
    if (!deps.interruptWakes) throw e;
    return { ready: { read: [], write: [] }, interrupted: true };
  }
}

function waitEvents(
  deps: PollDeps,
  subs: readonly Subscription[],
  { events, read, write }: { events: PollEvent[]; read: number[]; write: number[] },
  entered: boolean
): boolean {
  const earliest = subs.reduce((min, s) => Math.min(min, s.deadline), Infinity);
  const timeout = (): number => {
    if (events.length > 0 || entered) return 0;
    return earliest === Infinity ? -1 : Math.max(0, Math.ceil(earliest - performance.now()));
  };
  for (let resumes = 0; ; ) {
    const { ready, interrupted, resumed } = selectOnce(
      deps,
      read,
      write,
      timeout(),
      resumes++ < RESUMES
    );
    if (resumed) continue;
    events.push(...readyEvents(subs, ready));
    if (interrupted) return true;
    if (events.length > 0 || entered || earliest === Infinity) return false;
    if (performance.now() >= earliest) return false;
  }
}

export function pollOneoff(
  deps: PollDeps,
  inPtr: number,
  outPtr: number,
  nsubs: number,
  neventsPtr: number
): number {
  if (nsubs === 0) return E.INVAL;
  const { mem } = deps;
  const subs = readSubscriptions(mem, inPtr, nsubs, deps.now);
  const found = classify(deps.fds, subs);
  const { events, read, write } = found;
  const entered = deps.entered === true && deps.interruptWakes !== true;
  const waits = read.length > 0 || write.length > 0 || events.length === 0;
  const interrupted = waits && waitEvents(deps, subs, found, entered);
  const after = performance.now();
  if (entered && events.length === 0 && !subs.some((s) => s.deadline <= after)) return E.INTR;

  for (const s of subs) {
    if (s.type === EVENTTYPE.CLOCK && (interrupted || s.deadline <= after)) {
      events.push({ userdata: s.userdata, error: E.SUCCESS, type: s.type });
    }
  }
  writeEvents(mem, outPtr, events);
  mem.view().setUint32(neventsPtr, events.length, true);
  return E.SUCCESS;
}
