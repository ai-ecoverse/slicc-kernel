export const TIMER_MAX_MS = 0x7fff_ffff;

export function timerAt(deadline: number, fire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const left = deadline - performance.now();
    if (left > 0) {
      timer = setTimeout(arm, Math.min(left, TIMER_MAX_MS));
      return;
    }
    timer = undefined;
    fire();
  };
  timer = setTimeout(arm, Math.min(Math.max(0, deadline - performance.now()), TIMER_MAX_MS));
  return () => clearTimeout(timer);
}

export function timerAfter(ms: number, fire: () => void): () => void {
  return timerAt(performance.now() + ms, fire);
}

export function repeating(first: number, every: number, fire: () => void): () => void {
  let next = performance.now() + first;
  let cancel = (): void => {};
  const tick = (): void => {
    fire();
    if (every <= 0) return;
    next += every;
    const now = performance.now();
    if (next <= now) next += (Math.floor((now - next) / every) + 1) * every;
    cancel = timerAt(next, tick);
  };
  cancel = timerAt(next, tick);
  return () => cancel();
}
