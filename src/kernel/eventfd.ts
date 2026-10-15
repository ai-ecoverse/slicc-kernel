import { KernelError, type KernelFile, type PollState } from './fd-table.ts';

export const EVENTFD_MAX = 0xffff_ffff_ffff_fffen;

export class Notifier {
  private waiters: Array<() => void> = [];

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new KernelError('EINTR'));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new KernelError('EINTR'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

function blocked(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new KernelError('EAGAIN');
}

export class EventFd implements KernelFile {
  static readonly SIZE = 8;

  private count: bigint;
  private readonly semaphore: boolean;
  private readonly changes = new Notifier();

  constructor(initial: bigint, semaphore: boolean) {
    this.count = initial;
    this.semaphore = semaphore;
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (max < EventFd.SIZE) throw new KernelError('EINVAL');
    while (this.count === 0n) {
      blocked(signal);
      await this.changes.wait(signal);
    }
    const value = this.semaphore ? 1n : this.count;
    this.count -= value;
    this.changes.wake();
    const out = new Uint8Array(EventFd.SIZE);
    new DataView(out.buffer).setBigUint64(0, value, true);
    return out;
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (bytes.length < EventFd.SIZE) throw new KernelError('EINVAL');
    const value = new DataView(bytes.buffer, bytes.byteOffset, EventFd.SIZE).getBigUint64(0, true);
    if (value > EVENTFD_MAX) throw new KernelError('EINVAL');
    while (EVENTFD_MAX - this.count < value) {
      blocked(signal);
      await this.changes.wait(signal);
    }
    this.count += value;
    if (value > 0n) this.changes.wake();
    return EventFd.SIZE;
  }

  poll(): PollState {
    return { readable: this.count > 0n, writable: this.count < EVENTFD_MAX, hangup: false };
  }

  changed(signal?: AbortSignal): Promise<void> {
    return this.changes.wait(signal);
  }

  close(): void {
    this.changes.wake();
  }
}
