import type { RealmWebSocketClose, RealmWebSocketMessage } from './transport.ts';

export const INBOUND_LIMIT = 16 * 1024 * 1024;
export const MESSAGE_LIMIT = 64 * 1024 * 1024;
export const TOO_BIG = 1009;

export function payloadSize(message: RealmWebSocketMessage): number {
  return typeof message === 'string' ? new TextEncoder().encode(message).length : message.length;
}

export class MessageQueue implements AsyncIterable<RealmWebSocketMessage> {
  private readonly items: RealmWebSocketMessage[] = [];
  private readonly limit: number;
  private waiter: (() => void) | undefined;
  private size = 0;
  private ended = false;
  private readonly overflow: () => void;
  private readonly taken: ((n: number) => void) | undefined;
  readonly closed: Promise<RealmWebSocketClose>;
  private settle!: (close: RealmWebSocketClose) => void;

  constructor(overflow: () => void, limit = INBOUND_LIMIT, taken?: (n: number) => void) {
    this.overflow = overflow;
    this.limit = limit;
    this.taken = taken;
    this.closed = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  push(message: RealmWebSocketMessage): void {
    if (this.ended) return;
    const size = payloadSize(message);
    const huge = size > MESSAGE_LIMIT;
    if (huge || (this.items.length > 0 && this.size + size > this.limit)) {
      const reason = huge
        ? `a message is over ${MESSAGE_LIMIT} bytes`
        : `over ${this.limit} bytes of messages are waiting`;
      this.end({ code: TOO_BIG, reason });
      this.overflow();
      return;
    }
    this.size += size;
    this.items.push(message);
    this.wake();
  }

  end(close: RealmWebSocketClose): void {
    if (this.ended) return;
    this.ended = true;
    this.settle(close);
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RealmWebSocketMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        const n = payloadSize(next);
        this.size -= n;
        this.taken?.(n);
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}
