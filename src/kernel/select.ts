import { type FdTable, KernelError, pollFile } from './fd-table.ts';
import { timerAt } from './timer.ts';

export interface SelectResult {
  read: number[];
  write: number[];

  hangup?: number[];

  nread?: Record<number, number>;
}

function ready(fds: FdTable, read: readonly number[], write: readonly number[]): SelectResult {
  const hangup = new Set<number>();
  const nread: Record<number, number> = {};
  const pick = (list: readonly number[], dir: 'readable' | 'writable') =>
    list.filter((fd) => {
      const state = pollFile(fds.get(fd).file);
      if (state.hangup) hangup.add(fd);
      const picked = state[dir] || state.hangup;
      if (picked && dir === 'readable' && state.nread !== undefined) nread[fd] = state.nread;
      return picked;
    });
  const out: SelectResult = { read: pick(read, 'readable'), write: pick(write, 'writable') };
  if (hangup.size > 0) out.hangup = [...hangup];
  if (Object.keys(nread).length > 0) out.nread = nread;
  return out;
}

function interruption(signal: AbortSignal): { promise: Promise<never>; done(): void } {
  const { promise, reject } = Promise.withResolvers<never>();
  const fail = (): void => reject(new KernelError('EINTR'));
  if (signal.aborted) fail();
  else signal.addEventListener('abort', fail, { once: true });
  return { promise, done: () => signal.removeEventListener('abort', fail) };
}

export async function selectFds(
  fds: FdTable,
  read: readonly number[],
  write: readonly number[],
  timeoutMs: number,
  interrupt: AbortSignal
): Promise<SelectResult> {
  const deadline = timeoutMs < 0 ? Number.POSITIVE_INFINITY : performance.now() + timeoutMs;
  const interrupted = interruption(interrupt);
  interrupted.promise.catch(() => {});
  try {
    return await waitReady(fds, read, write, deadline, interrupted.promise);
  } finally {
    interrupted.done();
  }
}

async function waitReady(
  fds: FdTable,
  read: readonly number[],
  write: readonly number[],
  deadline: number,
  interrupted: Promise<never>
): Promise<SelectResult> {
  for (;;) {
    const now = ready(fds, read, write);
    if (now.read.length > 0 || now.write.length > 0 || performance.now() >= deadline) return now;

    const round = new AbortController();
    const changes = [...new Set([...read, ...write])].flatMap((fd) => {
      const file = fds.get(fd).file;
      return file.changed === undefined ? [] : [file.changed(round.signal).catch(() => undefined)];
    });
    let cancel = (): void => {};
    const expiry =
      deadline === Number.POSITIVE_INFINITY
        ? []
        : [new Promise<void>((resolve) => (cancel = timerAt(deadline, resolve)))];
    try {
      await Promise.race([...changes, ...expiry, interrupted]);
    } finally {
      round.abort();
      cancel();
    }
  }
}
