import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import { KernelError } from './fd-table.ts';

export type HostSyscall =
  | { op: 'lock'; path: string; exclusive: boolean; fd: number }
  | { op: 'unlock'; path: string }
  | { op: 'async-submit'; req: { op: string } }
  | { op: 'async-wait'; timeoutMs?: number }
  | { op: 'async-take'; id: number }
  | { op: 'async-resolve'; value: unknown }
  | { op: 'async-hold' }
  | { op: 'async-cancel'; id: number }
  | { op: 'async-close' };

export const HOST_OPS: readonly HostSyscall['op'][] = [
  'lock',
  'unlock',
  'async-submit',
  'async-wait',
  'async-take',
  'async-resolve',
  'async-hold',
  'async-cancel',
  'async-close',
];

const json = (value: unknown): SyncFsResult => ({ ok: true, kind: 'json', json: value });
const done: SyncFsResult = { ok: true, kind: 'void' };

interface Holder {
  exclusive: boolean;
  fds: Set<number>;
}

export class LockTable {
  private readonly held = new Map<string, Map<number, Holder>>();

  lock(pid: number, path: string, exclusive: boolean, fd: number): boolean {
    const holders = this.held.get(path) ?? new Map<number, Holder>();
    for (const [other, h] of holders) if (other !== pid && (exclusive || h.exclusive)) return false;
    const mine = holders.get(pid) ?? { exclusive, fds: new Set<number>() };
    mine.exclusive = exclusive;
    mine.fds.add(fd);
    holders.set(pid, mine);
    this.held.set(path, holders);
    return true;
  }

  unlock(pid: number, path: string): void {
    const holders = this.held.get(path);
    holders?.delete(pid);
    if (holders?.size === 0) this.held.delete(path);
  }

  closed(pid: number, fd: number): void {
    for (const [path, holders] of [...this.held]) {
      const mine = holders.get(pid);
      if (mine?.fds.delete(fd) && mine.fds.size === 0) this.unlock(pid, path);
    }
  }

  release(pid: number): void {
    for (const path of [...this.held.keys()]) this.unlock(pid, path);
  }
}

type Run = (req: { op: string }, cancelled: AbortSignal) => Promise<SyncFsResult>;

export class AsyncOps {
  private next = 1;
  private readonly results = new Map<number, SyncFsResult | undefined>();
  private readonly ready: number[] = [];
  private readonly running = new Map<number, AbortController>();
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private readonly run: Run;
  private readonly onReady: (() => void) | undefined;

  constructor(run: Run, onReady?: () => void) {
    this.run = run;
    this.onReady = onReady;
  }

  submit(req: { op: string }): number {
    const id = this.hold();
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
    return result;
  }

  cancel(id: number): void {
    this.running.get(id)?.abort();
    this.forget(id);
  }

  private forget(id: number): void {
    this.running.delete(id);
    this.results.delete(id);
    const at = this.ready.indexOf(id);
    if (at >= 0) this.ready.splice(at, 1);
  }

  async wait(timeoutMs: number | undefined, signal: AbortSignal): Promise<number> {
    for (;;) {
      if (this.closed) return -1;
      const id = this.ready.shift();
      if (id !== undefined) return id;
      if (timeoutMs !== undefined && timeoutMs <= 0) return 0;
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
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
        timer = setTimeout(() => {
          cleanup();
          resolve(false);
        }, timeoutMs);
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
  locks: LockTable | undefined;
  ops: AsyncOps;
  blocking: () => AbortSignal;
  valid: (req: { op: string }) => boolean;
}

export async function hostSyscall(req: HostSyscall, ctx: HostOpsContext): Promise<SyncFsResult> {
  switch (req.op) {
    case 'lock':
      if (!ctx.locks) throw new KernelError('ENOSYS');
      if (!ctx.locks.lock(ctx.pid, req.path, req.exclusive, req.fd))
        throw new KernelError('EAGAIN');
      return done;
    case 'unlock':
      ctx.locks?.unlock(ctx.pid, req.path);
      return done;
    case 'async-submit':
      if (!ctx.valid(req.req)) throw new KernelError('EINVAL');
      return json(ctx.ops.submit(req.req));
    case 'async-wait':
      return json(await ctx.ops.wait(req.timeoutMs, ctx.blocking()));
    case 'async-take':
      return ctx.ops.take(req.id);
    case 'async-resolve':
      return json(ctx.ops.resolve(req.value));
    case 'async-hold':
      return json(ctx.ops.hold());
    case 'async-cancel':
      ctx.ops.cancel(req.id);
      return done;
    case 'async-close':
      ctx.ops.close();
      return done;
  }
}
