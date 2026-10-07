import type {
  HeaderList,
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
  RealmTransportTraits,
} from './transport.ts';

export type TransportCall =
  | {
      net: 'fetch';
      nid: number;
      url: string;
      method: string;
      headers: HeaderList;
      body?: Uint8Array;
    }
  | { net: 'read'; nid: number }
  | { net: 'cancel'; nid: number };

export type TransportReply =
  | { net: 'head'; nid: number; status: number; statusText: string; headers: HeaderList }
  | { net: 'chunk'; nid: number; bytes: Uint8Array }
  | { net: 'end'; nid: number }
  | { net: 'error'; nid: number; message: string; status?: number; code?: string };

export interface TransportPort {
  postMessage(message: TransportCall): void;
}

export class TransportError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Waiter {
  resolve(reply: TransportReply): void;
  reject(error: Error): void;
}

export class RemoteTransport implements RealmTransport {
  readonly traits: RealmTransportTraits;

  private readonly port: TransportPort;

  private readonly waiting = new Map<number, Waiter>();

  private nextId = 0;

  private failure: Error | undefined;

  constructor(port: TransportPort, traits: RealmTransportTraits) {
    this.port = port;
    this.traits = traits;
  }

  receive(reply: TransportReply): void {
    const waiter = this.waiting.get(reply.nid);
    if (!waiter) return;
    this.waiting.delete(reply.nid);
    if (reply.net === 'error') {
      waiter.reject(new TransportError(reply.message, reply.status, reply.code));
    } else waiter.resolve(reply);
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }

  private ask(call: TransportCall): Promise<TransportReply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting.set(call.nid, { resolve, reject });
      this.port.postMessage(call);
    });
  }

  private cancel(nid: number): void {
    const waiter = this.waiting.get(nid);
    this.waiting.delete(nid);
    waiter?.reject(new TransportError('the request was cancelled'));
    this.port.postMessage({ net: 'cancel', nid });
  }

  async fetch(request: RealmTransportRequest): Promise<RealmTransportResponse> {
    const nid = ++this.nextId;
    const { signal } = request;
    signal.throwIfAborted();
    let finished = false;
    const abort = () => {
      finished = true;
      this.cancel(nid);
    };
    signal.addEventListener('abort', abort, { once: true });
    const finish = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
    };
    let head: TransportReply;
    try {
      head = await this.ask({
        net: 'fetch',
        nid,
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(request.body ? { body: request.body } : {}),
      });
    } catch (e) {
      finish();
      throw e;
    }
    const { status, statusText, headers } = head as Extract<TransportReply, { net: 'head' }>;
    const read = async (): Promise<Uint8Array | undefined> => {
      if (finished) return undefined;
      const reply = await this.ask({ net: 'read', nid }).catch((e: unknown) => {
        finish();
        throw e;
      });
      if (reply.net === 'chunk') return reply.bytes;
      finish();
      return undefined;
    };
    const cancel = async () => {
      if (finished) return;
      finish();
      this.cancel(nid);
    };
    return {
      status,
      statusText,
      headers,
      cancel,
      body: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const bytes = await read();
            return bytes ? { value: bytes, done: false } : { value: undefined, done: true };
          },
          return: async () => {
            await cancel();
            return { value: undefined, done: true };
          },
        }),
      },
    };
  }
}
