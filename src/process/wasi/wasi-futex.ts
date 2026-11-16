const FUTEX_SLICE_MS = 50;

export function futexWait(
  view: Int32Array,
  index: number,
  expected: number,
  ms: number,
  interrupted: (() => boolean) | undefined
): boolean {
  const deadline = performance.now() + ms;
  for (;;) {
    const slice = interrupted ? Math.min(FUTEX_SLICE_MS, ms) : ms;
    if (Atomics.wait(view, index, expected, slice) !== 'timed-out') return true;
    if (interrupted?.()) return true;
    ms = deadline - performance.now();
    if (ms <= 0) return false;
  }
}

export interface Futexes {
  wait(
    view: Int32Array,
    index: number,
    expected: number,
    ms: number,
    interrupted: (() => boolean) | undefined
  ): boolean;
  notify(view: Int32Array, index: number, count?: number): number;
  pause(): void;
}

export const atomicFutexes: Futexes = {
  wait: futexWait,
  notify: (view, index, count) => Atomics.notify(view, index, count),
  pause: () => {},
};
