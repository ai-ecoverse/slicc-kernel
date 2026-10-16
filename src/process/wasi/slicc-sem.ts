import type { SemWaitHow } from '../../kernel/sem.ts';
import { CLOCK } from './wasi-abi.ts';
import { WasiError } from './wasi-files.ts';
import type { WasiFunction, WasiHost } from './wasi-host.ts';

const SEM_CREAT = 1;
const SEM_EXCL = 2;
const HOW: readonly SemWaitHow[] = ['block', 'try', 'timed'];
const NS_PER_MS = 1_000_000n;
const MAX_TIMEOUT_MS = 0x7fff_ffff;

export function remainingMs(deadline: bigint, now: bigint): number {
  if (deadline <= now) return 0;
  const ms = (deadline - now + NS_PER_MS - 1n) / NS_PER_MS;
  return ms > BigInt(MAX_TIMEOUT_MS) ? MAX_TIMEOUT_MS : Number(ms);
}

export function semImports(host: WasiHost): Record<string, WasiFunction> {
  const { mem } = host;
  const call = (req: Parameters<typeof host.o.kernel.call>[0]) => host.o.kernel.call(req);
  const name = (ptr: number, len: number) => mem.string(ptr, len);
  return {
    sem_open: (np: number, nl: number, oflag: number, mode: number, value: number, out: number) => {
      const handle = call({
        op: 'sem-open',
        name: name(np, nl),
        create: (oflag & SEM_CREAT) !== 0,
        exclusive: (oflag & SEM_EXCL) !== 0,
        mode,
        value,
      }) as number;
      mem.view().setUint32(out, handle, true);
    },
    sem_close: (handle: number) => void call({ op: 'sem-close', handle }),
    sem_unlink: (np: number, nl: number) => void call({ op: 'sem-unlink', name: name(np, nl) }),
    sem_post: (handle: number) => void call({ op: 'sem-post', handle }),
    sem_wait: (handle: number, how: number, clock: number, deadline: bigint) => {
      const kind = HOW[how];
      if (!kind) throw new WasiError('EINVAL');
      let timeoutMs = -1;
      if (kind === 'timed') {
        if (deadline < 0n) throw new WasiError('EINVAL');
        if (clock !== CLOCK.REALTIME && clock !== CLOCK.MONOTONIC) throw new WasiError('EINVAL');
        timeoutMs = remainingMs(deadline, host.now(clock));
      }
      call({ op: 'sem-wait', handle, how: kind, timeoutMs });
    },
    sem_getvalue: (handle: number, out: number) =>
      void mem.view().setInt32(out, call({ op: 'sem-getvalue', handle }) as number, true),
  };
}
