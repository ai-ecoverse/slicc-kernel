import type { Futexes } from '../process/wasi/wasi-futex.ts';
import type { AsyncTransport } from './transport.ts';

export const FUTEX_WAIT = 'futex-wait';

type Later = (fn: () => void) => void;

function later(fn: () => void): void {
  const immediate = (globalThis as { setImmediate?: Later }).setImmediate;
  if (immediate) immediate(fn);
  else setTimeout(fn, 0);
}

export class FutexHub {
  private readonly sleepers = new Map<number, Set<() => void>>();

  threads = 1;

  sleep(index: number): { woken: Promise<void>; cancel(): void } {
    let set = this.sleepers.get(index);
    if (!set) {
      set = new Set();
      this.sleepers.set(index, set);
    }
    const own = set;
    let wake = (): void => {};
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    own.add(wake);
    const cancel = (): void => {
      own.delete(wake);
      if (own.size === 0 && this.sleepers.get(index) === own) this.sleepers.delete(index);
    };
    return { woken, cancel };
  }

  wake(index: number, count = Number.POSITIVE_INFINITY): number {
    const set = this.sleepers.get(index);
    if (!set) return 0;
    let woken = 0;
    for (const wake of [...set]) {
      if (woken >= count) break;
      set.delete(wake);
      wake();
      woken++;
    }
    if (set.size === 0) this.sleepers.delete(index);
    return woken;
  }
}

export function asyncFutexes(
  hub: FutexHub,
  transport: Pick<AsyncTransport, 'call' | 'watch' | 'cancel'>
): Futexes {
  const timed = async (ms: number, woken: Promise<void>): Promise<boolean> => {
    const timeoutMs = Math.max(1, Math.ceil(ms));
    const waited = transport.call(
      { op: 'fd-select', read: [], write: [], timeoutMs },
      Number.POSITIVE_INFINITY,
      FUTEX_WAIT
    );
    const first = await Promise.race([woken.then(() => undefined), waited]);
    if (first !== undefined) return !first.ok;
    transport.cancel();
    waited.catch(() => undefined);
    return true;
  };
  const futexes = {
    async wait(view: Int32Array, index: number, expected: number, ms: number) {
      if (Atomics.load(view, index) !== expected) return true;
      if (!(ms > 0)) return false;
      const sleep = hub.sleep(index);
      try {
        if (Number.isFinite(ms)) {
          return (await timed(ms, sleep.woken)) || Atomics.load(view, index) !== expected;
        }
        const watch = transport.watch();
        try {
          await Promise.race([sleep.woken, watch.changed]);
        } finally {
          watch.forget();
        }
        return true;
      } finally {
        sleep.cancel();
      }
    },
    notify: (view: Int32Array, index: number, count?: number) =>
      hub.wake(index, count) + Atomics.notify(view, index, count),
    async pause() {
      if (hub.threads > 1) await new Promise<void>((resolve) => later(resolve));
    },
  };
  return futexes as unknown as Futexes;
}
