import { SpawnError } from '../kernel/children.ts';

export const MAX_ISOLATES = 8;
export const ISOLATE_WAIT_MS = 10_000;

interface Waiter {
  id: string;
  admit(): void;
}

export class IsolateGate {
  private readonly live = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  peak = 0;

  readonly max: number;
  readonly waitMs: number;

  constructor(max = MAX_ISOLATES, waitMs = ISOLATE_WAIT_MS) {
    this.max = max;
    this.waitMs = waitMs;
  }

  get active(): number {
    return this.live.size;
  }

  private enter(id: string): () => void {
    this.live.set(id, (this.live.get(id) ?? 0) + 1);
    this.peak = Math.max(this.peak, this.live.size);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.leave(id);
    };
  }

  private leave(id: string): void {
    const n = (this.live.get(id) ?? 1) - 1;
    if (n > 0) {
      this.live.set(id, n);
      return;
    }
    this.live.delete(id);
    this.wake();
  }

  tryAcquire(id: string): (() => void) | undefined {
    if (!this.fits(id) || (this.queue.length > 0 && !this.live.has(id))) return undefined;
    return this.enter(id);
  }

  fits(id: string): boolean {
    return this.live.has(id) || this.live.size < this.max;
  }

  private wake(): void {
    for (let at = 0; at < this.queue.length; ) {
      const waiter = this.queue[at]!;
      if (!this.fits(waiter.id)) {
        at++;
        continue;
      }
      this.queue.splice(at, 1);
      waiter.admit();
    }
  }

  acquire(id: string): Promise<() => void> {
    if (this.fits(id) && this.queue.length === 0) return Promise.resolve(this.enter(id));
    if (this.live.has(id)) return Promise.resolve(this.enter(id));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        id,
        admit: () => {
          clearTimeout(timer);
          resolve(this.enter(id));
        },
      };
      const timer = setTimeout(() => {
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
        reject(new SpawnError('EAGAIN'));
      }, this.waitMs);
      this.queue.push(waiter);
    });
  }
}
