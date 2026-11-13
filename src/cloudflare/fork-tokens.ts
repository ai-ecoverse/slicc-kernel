import { ASYNC_SNAPSHOT_TAKEN } from '../async/wire.ts';
import { decodeSabResult } from '../realm/sync-sab-wire.ts';
import { dispose, type ProcessEndStub } from './rpc-link.ts';

export const FORK_TOKEN_TTL_MS = 30_000;

interface Holder {
  end: ProcessEndStub;
  total: number;
  timer: ReturnType<typeof setTimeout>;
  unhold: () => void;
}

interface ForkCall {
  type?: unknown;
  req?: { op?: unknown; state?: { snapshot?: { token?: unknown; total?: unknown } } };
}

export class ForkTokens {
  private readonly held = new Map<string, Holder>();
  private readonly ttlMs: number;
  fetched = 0;
  taken = 0;

  constructor(ttlMs = FORK_TOKEN_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.held.size;
  }

  watchCall(
    message: unknown,
    end: ProcessEndStub | undefined,
    hold: (bytes: number) => () => void = () => () => {}
  ): string | undefined {
    const call = message as ForkCall | null;
    if (!end || call?.type !== 'async-syscall' || call.req?.op !== 'proc-fork') return undefined;
    const snapshot = call.req.state?.snapshot;
    if (typeof snapshot?.token !== 'string' || typeof snapshot.total !== 'number') return undefined;
    this.hold(snapshot.token, snapshot.total, end, hold(snapshot.total));
    return snapshot.token;
  }

  watchAnswer(token: string | undefined, answer: unknown): void {
    if (token === undefined) return;
    const reply = answer as { failed?: unknown; status?: unknown; bytes?: unknown } | null;
    if (!reply || reply.failed !== undefined) {
      this.drop(token);
      return;
    }
    if (typeof reply.status !== 'number' || !(reply.bytes instanceof Uint8Array)) return;
    try {
      if (!decodeSabResult(reply.status, reply.bytes).ok) this.drop(token);
    } catch {
      this.drop(token);
    }
  }

  watchPost(message: unknown): boolean {
    const post = message as { type?: unknown; token?: unknown } | null;
    if (post?.type !== ASYNC_SNAPSHOT_TAKEN) return false;
    if (typeof post.token === 'string') {
      this.taken++;
      this.drop(post.token);
    }
    return true;
  }

  private hold(token: string, total: number, end: ProcessEndStub, unhold: () => void): void {
    this.drop(token);
    const timer = setTimeout(() => this.drop(token), this.ttlMs);
    this.held.set(token, { end: end.dup(), total, timer, unhold });
  }

  drop(token: string): void {
    const holder = this.held.get(token);
    if (!holder) return;
    clearTimeout(holder.timer);
    this.held.delete(token);
    holder.unhold();
    dispose(holder.end);
  }

  async read(token: string, offset: number, max: number): Promise<Uint8Array> {
    const holder = this.held.get(token);
    if (!holder) throw new Error('async: the fork snapshot is gone');
    const bytes = await holder.end.snapshot(token, offset, max);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      this.drop(token);
      throw new Error('async: the parent no longer has the fork snapshot');
    }
    this.fetched++;
    if (offset + bytes.byteLength >= holder.total) this.drop(token);
    return bytes;
  }

  clear(): void {
    for (const token of [...this.held.keys()]) this.drop(token);
  }
}
