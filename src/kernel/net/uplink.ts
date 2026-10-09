import type { RouteTable } from './routes.ts';

export interface UplinkTraits {
  tcp: true;
  udp: false;
  ipv6: boolean;
}

export type ResolveFamily = 0 | 4 | 6;

export interface ResolveAnswer {
  addresses: string[];
  ttl?: number;
}

export interface NetworkUplink {
  readonly traits: UplinkTraits;
  readonly routes?: RouteTable;
  resolve(
    name: string,
    family: ResolveFamily,
    signal?: AbortSignal
  ): Promise<string[] | ResolveAnswer>;
}

export type UplinkCall =
  | { uplink: 'resolve'; uid: number; name: string; family: ResolveFamily }
  | { uplink: 'cancel'; uid: number };

export type UplinkReply =
  | { uplink: 'resolved'; uid: number; addresses: string[]; ttl?: number }
  | { uplink: 'error'; uid: number; message: string; code?: string };

export interface UplinkPeer {
  postMessage(message: UplinkReply): void;
}

export interface UplinkPort {
  postMessage(message: UplinkCall): void;
}

export function answerOf(result: string[] | ResolveAnswer): ResolveAnswer {
  const answer = Array.isArray(result) ? { addresses: result } : result;
  const addresses = Array.isArray(answer?.addresses)
    ? answer.addresses.filter((a): a is string => typeof a === 'string')
    : [];
  return {
    addresses,
    ...(typeof answer?.ttl === 'number' && answer.ttl >= 0 ? { ttl: answer.ttl } : {}),
  };
}

function failure(uid: number, e: unknown): UplinkReply {
  const code = (e as { code?: unknown } | null)?.code;
  return {
    uplink: 'error',
    uid,
    message: e instanceof Error ? e.message : String(e),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

export interface UplinkServer {
  answer(call: UplinkCall): void;
  close(): void;
}

export function serveUplink(peer: UplinkPeer, uplink: NetworkUplink): UplinkServer {
  const pending = new Map<number, AbortController>();
  const answer = (call: UplinkCall) => {
    if (call.uplink === 'cancel') return pending.get(call.uid)?.abort();
    const abort = new AbortController();
    pending.set(call.uid, abort);
    void (async () => {
      try {
        const answer = answerOf(await uplink.resolve(call.name, call.family, abort.signal));
        peer.postMessage({ uplink: 'resolved', uid: call.uid, ...answer });
      } catch (e) {
        peer.postMessage(failure(call.uid, e));
      } finally {
        pending.delete(call.uid);
      }
    })();
  };
  return {
    answer,
    close: () => {
      for (const abort of pending.values()) abort.abort();
    },
  };
}

export class RemoteUplink implements NetworkUplink {
  readonly traits: UplinkTraits;
  readonly routes: RouteTable | undefined;
  private readonly port: UplinkPort;
  private readonly waiting = new Map<number, PromiseWithResolvers<ResolveAnswer>>();
  private nextId = 0;

  constructor(port: UplinkPort, traits: UplinkTraits, routes?: RouteTable) {
    this.port = port;
    this.traits = traits;
    this.routes = routes;
  }

  receive(reply: UplinkReply): void {
    const waiter = this.waiting.get(reply.uid);
    if (!waiter) return;
    this.waiting.delete(reply.uid);
    if (reply.uplink === 'error') {
      waiter.reject(Object.assign(new Error(reply.message), { code: reply.code }));
    } else waiter.resolve(answerOf(reply));
  }

  resolve(name: string, family: ResolveFamily, signal?: AbortSignal): Promise<ResolveAnswer> {
    const uid = ++this.nextId;
    const waiter = Promise.withResolvers<ResolveAnswer>();
    this.waiting.set(uid, waiter);
    signal?.addEventListener(
      'abort',
      () => {
        this.waiting.delete(uid);
        this.port.postMessage({ uplink: 'cancel', uid });
        waiter.reject(signal.reason);
      },
      { once: true }
    );
    this.port.postMessage({ uplink: 'resolve', uid, name, family });
    return waiter.promise;
  }
}
