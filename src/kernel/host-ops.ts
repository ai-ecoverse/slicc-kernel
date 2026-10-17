import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import { KernelError } from './fd-table.ts';
import type { KernelLocks } from './lock-service.ts';
import { type FlockKind, type LockKind, lockRange } from './locks.ts';
import { timerAfter } from './timer.ts';

export interface LockTarget {
  path?: string;
  fd?: number;
}

export type HostSyscall =
  | { op: 'lock'; path: string; exclusive: boolean; fd: number }
  | { op: 'unlock'; path: string; fd?: number }
  | ({
      op: 'lk-set';
      kind: LockKind | 'unlock';
      start: number;
      len: number;
      wait?: boolean;
    } & LockTarget)
  | ({ op: 'lk-get'; kind: LockKind; start: number; len: number } & LockTarget)
  | ({ op: 'lk-close' } & LockTarget)
  | { op: 'flock'; fd: number; kind: FlockKind | 'unlock'; wait?: boolean }
  | { op: 'async-submit'; req: { op: string }; ack?: number[] }
  | { op: 'async-wait'; timeoutMs?: number }
  | { op: 'async-take'; id: number }
  | { op: 'async-resolve'; value: unknown }
  | { op: 'async-hold' }
  | { op: 'async-cancel'; id: number }
  | { op: 'async-settle'; ids: number[] }
  | { op: 'async-close' };

export const HOST_OPS: readonly HostSyscall['op'][] = [
  'lock',
  'unlock',
  'lk-set',
  'lk-get',
  'lk-close',
  'flock',
  'async-submit',
  'async-wait',
  'async-take',
  'async-resolve',
  'async-hold',
  'async-cancel',
  'async-settle',
  'async-close',
];

const json = (value: unknown): SyncFsResult => ({ ok: true, kind: 'json', json: value });
const done: SyncFsResult = { ok: true, kind: 'void' };

type Run = (req: { op: string }, cancelled: AbortSignal) => Promise<SyncFsResult>;

const KEPT_OPS = new Set(['fd-write']);

let unknownSettled = false;

export class AsyncOps {
  private next = 1;
  private readonly results = new Map<number, SyncFsResult | undefined>();
  private readonly ready: number[] = [];
  private readonly running = new Map<number, AbortController>();
  private readonly waiters = new Set<() => void>();
  private readonly taken = new Map<number, SyncFsResult>();
  private readonly kept = new Set<number>();
  private closed = false;
  private readonly run: Run;
  private readonly onReady: (() => void) | undefined;

  constructor(run: Run, onReady?: () => void) {
    this.run = run;
    this.onReady = onReady;
  }

  submit(req: { op: string }): number {
    const id = this.hold();
    if (KEPT_OPS.has(req.op)) this.kept.add(id);
    const running = new AbortController();
    this.running.set(id, running);
    this.run(req, running.signal).then(
      (result) => this.complete(id, result),
      (err: unknown) => this.complete(id, { ok: false, errno: 'EIO', message: String(err) })
    );
    return id;
  }

  resolve(value: unknown): number {
    const id = this.hold();
    this.complete(id, json(value));
    return id;
  }

  hold(): number {
    const id = this.next++;
    this.results.set(id, undefined);
    return id;
  }

  take(id: number): SyncFsResult {
    if (!this.results.has(id)) throw new KernelError('EINVAL');
    const result = this.results.get(id);
    if (!result) throw new KernelError('EAGAIN');
    this.forget(id);
    if (this.kept.delete(id)) this.taken.set(id, result);
    return result;
  }

  ack(ids: readonly number[]): void {
    for (const id of ids) this.taken.delete(id);
  }

  async settle(ids: readonly number[]): Promise<Array<SyncFsResult | null>> {
    const never = new AbortController().signal;
    while (ids.some((id) => this.running.has(id))) await this.sleep(undefined, never);
    return ids.map((id) => {
      const result = this.results.get(id) ?? this.taken.get(id) ?? null;
      if (!result && !unknownSettled) {
        unknownSettled = true;
        console.warn(`async-settle: no result for op ${id}; its write counts as made`);
      }
      return result;
    });
  }

  cancel(id: number): void {
    this.kept.delete(id);
    this.running.get(id)?.abort();
    this.forget(id);
  }

  private forget(id: number): void {
    this.running.delete(id);
    this.results.delete(id);
    const at = this.ready.indexOf(id);
    if (at >= 0) this.ready.splice(at, 1);
  }

  async wait(timeoutMs: number | undefined, blocking: () => AbortSignal): Promise<number> {
    let signal: AbortSignal | undefined;
    for (;;) {
      if (this.closed) return -1;
      const id = this.ready.shift();
      if (id !== undefined) return id;
      if (timeoutMs !== undefined && timeoutMs <= 0) return 0;
      signal ??= blocking();
      const woke = await this.sleep(timeoutMs, signal);
      if (!woke) return 0;
    }
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private sleep(timeoutMs: number | undefined, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let cancel = (): void => {};
      const cleanup = () => {
        cancel();
        this.waiters.delete(wake);
        signal.removeEventListener('abort', abort);
      };
      const wake = () => {
        cleanup();
        resolve(true);
      };
      const abort = () => {
        cleanup();
        reject(new KernelError('EINTR'));
      };
      this.waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
      if (timeoutMs !== undefined) {
        cancel = timerAfter(timeoutMs, () => {
          cleanup();
          resolve(false);
        });
      }
    });
  }

  private complete(id: number, result: SyncFsResult): void {
    this.running.delete(id);
    if (!this.results.has(id)) return;
    this.results.set(id, result);
    this.ready.push(id);
    this.wake();
    this.onReady?.();
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

export interface HostOpsContext {
  pid: number;
  owner?: () => number;
  fileKey?: (
    target: LockTarget,
    kind: LockKind | 'unlock' | 'close',
    setting?: boolean
  ) => Promise<string>;
  flockOf?: (fd: number) => Promise<{ key: string; owner: object }>;
  settle?: (fd: number, granted: boolean) => Promise<void>;
  locks: KernelLocks | undefined;
  ops: AsyncOps;
  blocking: () => AbortSignal;
  valid: (req: { op: string }) => boolean;
}

export async function hostSyscall(req: HostSyscall, ctx: HostOpsContext): Promise<SyncFsResult> {
  switch (req.op) {
    case 'lock':
      return wholeLock(req, ctx);
    case 'unlock':
      ctx.locks?.unlock(ctx.pid, req.path);
      if (req.fd !== undefined && ctx.locks?.shared?.() && ctx.flockOf) {
        return flock({ op: 'flock', fd: req.fd, kind: 'unlock' }, ctx);
      }
      return done;
    case 'lk-set':
    case 'lk-get':
    case 'lk-close':
      return recordLock(req, ctx);
    case 'flock':
      return flock(req, ctx);
    case 'async-submit':
      if (!ctx.valid(req.req)) throw new KernelError('EINVAL');
      if (req.ack) ctx.ops.ack(req.ack);
      return json(ctx.ops.submit(req.req));
    case 'async-wait':
      return json(await ctx.ops.wait(req.timeoutMs, ctx.blocking));
    case 'async-take':
      return ctx.ops.take(req.id);
    case 'async-resolve':
      return json(ctx.ops.resolve(req.value));
    case 'async-hold':
      return json(ctx.ops.hold());
    case 'async-cancel':
      ctx.ops.cancel(req.id);
      return done;
    case 'async-settle':
      return json(await ctx.ops.settle(req.ids));
    case 'async-close':
      ctx.ops.close();
      return done;
  }
}

async function wholeLock(
  req: Extract<HostSyscall, { op: 'lock' }>,
  ctx: HostOpsContext
): Promise<SyncFsResult> {
  const { locks, flockOf } = ctx;
  if (!locks) throw new KernelError('ENOSYS');
  const kind = req.exclusive ? 'exclusive' : 'shared';
  if (locks.shared?.() && flockOf) {
    if (locks.wholeFree?.(ctx.pid, req.path, req.exclusive) === false) {
      throw new KernelError('EAGAIN');
    }
    return flock({ op: 'flock', fd: req.fd, kind }, ctx);
  }
  if (flockOf && locks.flockFree) {
    const { key, owner } = await flockOf(req.fd);
    if (!locks.flockFree(key, owner, kind)) throw new KernelError('EAGAIN');
  }
  if (!locks.lock(ctx.pid, req.path, req.exclusive, req.fd)) throw new KernelError('EAGAIN');
  return done;
}

const FLOCK_KINDS: ReadonlySet<string> = new Set(['shared', 'exclusive', 'unlock']);

async function flock(
  req: Extract<HostSyscall, { op: 'flock' }>,
  ctx: HostOpsContext
): Promise<SyncFsResult> {
  const { locks, flockOf } = ctx;
  if (!locks || !flockOf) throw new KernelError('ENOLCK');
  if (!FLOCK_KINDS.has(req.kind)) throw new KernelError('EINVAL');
  const { key, owner } = await flockOf(req.fd);
  const granted = req.kind !== 'unlock';
  const shared = locks.shared?.() === true;
  if (shared && !granted) await ctx.settle?.(req.fd, false);
  if (req.kind !== 'unlock' && req.wait)
    await locks.flocks.wait(key, owner, req.kind, ctx.blocking);
  else if (!(await locks.flocks.set(key, owner, req.kind))) throw new KernelError('EAGAIN');
  if (shared && granted) await ctx.settle?.(req.fd, true);
  return shared ? json(true) : done;
}

async function recordLock(
  req: Extract<HostSyscall, { op: 'lk-set' | 'lk-get' | 'lk-close' }>,
  ctx: HostOpsContext
): Promise<SyncFsResult> {
  const { locks, fileKey } = ctx;
  if (!locks || !fileKey) throw new KernelError('ENOLCK');
  const owner = ctx.owner?.() ?? ctx.pid;
  const target = {
    ...(req.path !== undefined ? { path: req.path } : {}),
    ...(req.fd !== undefined ? { fd: req.fd } : {}),
  };
  if (req.op === 'lk-close') {
    if (req.fd !== undefined && locks.shared?.()) await ctx.settle?.(req.fd, false);
    locks.dropFile(await fileKey(target, 'close'), owner);
    return done;
  }
  const range = lockRange(req.start, req.len);
  const key = await fileKey(target, req.kind, req.op === 'lk-set' && req.fd !== undefined);
  if (req.op === 'lk-get') {
    const held = await locks.holder(key, owner, { key, kind: req.kind, ...range });
    if (!held) return json(null);
    const len = held.end === Number.POSITIVE_INFINITY ? 0 : held.end - held.start;
    return json({ kind: held.kind, pid: held.owner, start: held.start, len });
  }
  const granted = req.kind !== 'unlock';
  const shared = locks.shared?.() === true;
  const fd = shared ? req.fd : undefined;
  if (!granted && fd !== undefined) await ctx.settle?.(fd, false);
  if (req.kind !== 'unlock' && req.wait)
    await locks.wait(key, owner, req.kind, range, ctx.blocking);
  else if (!(await locks.set(key, owner, req.kind, range.start, range.end)))
    throw new KernelError('EAGAIN');
  if (granted && fd !== undefined) await ctx.settle?.(fd, true);
  return shared ? json(true) : done;
}
