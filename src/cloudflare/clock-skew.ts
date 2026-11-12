const ASYNC_SYSCALL = 'async-syscall';

interface Timed {
  op?: unknown;
  timeoutMs?: unknown;
  ms?: unknown;
  firstMs?: unknown;
}

function later(req: Timed, lag: number): Timed {
  if (typeof req.timeoutMs === 'number' && req.timeoutMs > 0) {
    return { ...req, timeoutMs: req.timeoutMs + lag };
  }
  if (req.op === 'proc-alarm' && typeof req.ms === 'number') {
    const first = typeof req.firstMs === 'number' ? req.firstMs : req.ms;
    return first > 0 ? { ...req, firstMs: first + lag } : req;
  }
  return req;
}

export function behindProcess(message: unknown, sent: unknown, now = Date.now()): unknown {
  const call = message as { type?: unknown; req?: unknown } | null;
  if (call?.type !== ASYNC_SYSCALL || !call.req || typeof call.req !== 'object') return message;
  if (typeof sent !== 'number' || !(sent > now)) return message;
  const req = later(call.req as Timed, sent - now);
  return req === call.req ? message : { ...call, req };
}

export function timed(message: unknown): boolean {
  const call = message as { type?: unknown; req?: Timed } | null;
  if (call?.type !== ASYNC_SYSCALL || !call.req) return false;
  const { req } = call;
  if (typeof req.timeoutMs === 'number') return req.timeoutMs > 0;
  return req.op === 'proc-alarm' && typeof req.ms === 'number' && req.ms > 0;
}
