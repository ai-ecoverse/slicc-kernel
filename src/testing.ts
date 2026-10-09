import type { RouteTable } from './kernel/net/routes.ts';
import {
  answerOf,
  type NetworkUplink,
  type ResolveAnswer,
  type ResolveFamily,
  type UplinkConn,
  type UplinkDial,
} from './kernel/net/uplink.ts';

export type { NetworkUplink, ResolveAnswer, ResolveFamily, RouteTable, UplinkConn, UplinkDial };

export interface FakePeerSocket {
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): void;
  end(): void;
  reset(code?: string): void;
  readonly buffered: number;
  drained(): Promise<void>;
  readonly closed: Promise<void>;
}

export type FakePeer = ((socket: FakePeerSocket) => void) | { error: string } | { hang: true };

export interface FakeUplinkOptions {
  names?: Readonly<Record<string, string[] | ResolveAnswer>>;
  routes?: RouteTable;
  ipv6?: boolean;
  peers?: Readonly<Record<string, FakePeer>>;
  address?: string;
}

export interface FakeUplink extends NetworkUplink {
  readonly asked: Array<{ name: string; family: ResolveFamily }>;
  readonly dialled: Array<{ host: string; port: number }>;
}

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

class Stream {
  private readonly queue: Array<{
    bytes: Uint8Array;
    taken: () => void;
    lost: (error: Error) => void;
  }> = [];
  private ended = false;
  private broken: Error | undefined;
  private waiters: Array<() => void> = [];
  size = 0;

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  push(bytes: Uint8Array): Promise<void> {
    if (this.broken) return Promise.reject(this.broken);
    if (this.ended) return Promise.reject(failure('EPIPE', 'the stream is closed'));
    return new Promise((taken, lost) => {
      this.queue.push({ bytes: bytes.slice(), taken, lost });
      this.size += bytes.length;
      this.wake();
    });
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  fail(error: Error): void {
    this.broken = error;
    for (const pending of this.queue.splice(0)) pending.lost(error);
    this.size = 0;
    this.wake();
  }

  async read(): Promise<Uint8Array | null> {
    while (this.queue.length === 0 && !this.ended && !this.broken) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.broken) throw this.broken;
    const next = this.queue.shift();
    if (!next) return null;
    this.size -= next.bytes.length;
    next.taken();
    this.wake();
    return next.bytes;
  }

  async drained(): Promise<void> {
    while (this.size > 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

function named(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(failure('ECONNABORTED', 'dial aborted')), {
      once: true,
    });
  });
}

export function fakeUplink(options: FakeUplinkOptions = {}): FakeUplink {
  const asked: FakeUplink['asked'] = [];
  const dialled: FakeUplink['dialled'] = [];
  let nextPort = 40000;
  return {
    traits: { tcp: true, udp: false, ipv6: options.ipv6 === true },
    ...(options.routes ? { routes: options.routes } : {}),
    asked,
    dialled,
    resolve: async (name, family) => {
      asked.push({ name, family });
      return answerOf(options.names?.[name] ?? []);
    },
    dial: async ({ host, port, signal }) => {
      dialled.push({ host, port });
      const peer = options.peers?.[named(host, port)];
      if (!peer) throw failure('ECONNREFUSED', `nothing listens on ${named(host, port)}`);
      if ('error' in peer) throw failure(peer.error, `${named(host, port)}: ${peer.error}`);
      if ('hang' in peer) return hang(signal);
      const up = new Stream();
      const down = new Stream();
      const closed = Promise.withResolvers<void>();
      peer({
        read: () => up.read(),
        write: (bytes) => void down.push(bytes).catch(() => undefined),
        end: () => down.end(),
        reset: (code = 'ECONNRESET') => {
          const error = failure(code, `the peer reset the connection (${code})`);
          up.fail(error);
          down.fail(error);
        },
        get buffered() {
          return down.size;
        },
        drained: () => down.drained(),
        closed: closed.promise,
      });
      return {
        localAddr: named(options.address ?? '100.100.100.100', nextPort++),
        remoteAddr: named(host, port),
        read: () => down.read(),
        write: async (bytes) => {
          await up.push(bytes);
          return bytes.length;
        },
        closeWrite: () => up.end(),
        close: () => {
          up.end();
          down.end();
          closed.resolve();
        },
      };
    },
  };
}
