export interface CronClock {
  now(): number;
  readonly utc?: boolean;
  sleep(until: number, signal: AbortSignal): Promise<void>;
}

export const systemCronClock: CronClock = {
  now: () => Date.now(),
  sleep(until, signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, until - Date.now()));
      (timer as { unref?: () => void }).unref?.();
      signal.addEventListener('abort', done, { once: true });
    });
  },
};

export interface FakeCronClock extends CronClock {
  set(ms: number): void;
  advance(ms: number): void;
  flush(): Promise<void>;
  readonly sleepers: number;
}

interface Sleeper {
  until: number;
  wake: () => void;
  ring: () => void;
}

export function fakeCronClock(start = Date.UTC(2026, 0, 1), utc = true): FakeCronClock {
  let now = start;
  const sleepers = new Set<Sleeper>();
  let idle: Array<() => void> = [];
  let awake = 0;
  const settled = () =>
    awake === 0 && sleepers.size > 0 && [...sleepers].every((s) => s.until > now);
  const check = () => {
    if (!settled()) return;
    const waiting = idle;
    idle = [];
    for (const resolve of waiting) resolve();
  };
  const wakeDue = () => {
    for (const sleeper of [...sleepers]) if (sleeper.until <= now) sleeper.ring();
  };
  return {
    utc,
    now: () => now,
    get sleepers() {
      return sleepers.size;
    },
    sleep(until, signal) {
      if (signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const sleeper: Sleeper = {
          until,
          wake: () => {
            sleepers.delete(sleeper);
            signal.removeEventListener('abort', sleeper.wake);
            resolve();
          },
          ring: () => {
            if (!sleepers.has(sleeper)) return;
            awake++;
            sleeper.wake();
          },
        };
        awake = Math.max(0, awake - 1);
        signal.addEventListener('abort', sleeper.wake, { once: true });
        sleepers.add(sleeper);
        if (until <= now) queueMicrotask(sleeper.ring);
        else check();
      });
    },
    set(ms) {
      now = ms;
      wakeDue();
    },
    advance(ms) {
      now += ms;
      wakeDue();
    },
    flush() {
      return new Promise((resolve) => {
        idle.push(resolve);
        queueMicrotask(check);
      });
    },
  };
}
