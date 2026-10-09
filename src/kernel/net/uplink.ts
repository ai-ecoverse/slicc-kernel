import { Routes, type RouteTable } from './routes.ts';

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

export interface UplinkConn {
  readonly localAddr: string;
  readonly remoteAddr: string;
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<number>;
  closeWrite(): void;
  close(): void;
}

export interface UplinkDial {
  network: 'tcp';
  host: string;
  port: number;
  signal: AbortSignal;
}

export interface NetworkUplink {
  readonly traits: UplinkTraits;
  readonly routes?: RouteTable;
  resolve(
    name: string,
    family: ResolveFamily,
    signal?: AbortSignal
  ): Promise<string[] | ResolveAnswer>;
  dial(req: UplinkDial): Promise<UplinkConn>;
}

export type UplinkCall =
  | { uplink: 'resolve'; uid: number; name: string; family: ResolveFamily }
  | { uplink: 'dial'; uid: number; host: string; port: number }
  | { uplink: 'cancel'; uid: number }
  | { uplink: 'read'; uid: number; cid: number }
  | { uplink: 'write'; uid: number; cid: number; bytes: Uint8Array }
  | { uplink: 'close-write'; cid: number }
  | { uplink: 'close'; cid: number };

export type UplinkReply =
  | { uplink: 'resolved'; uid: number; addresses: string[]; ttl?: number }
  | { uplink: 'dialled'; uid: number; cid: number; localAddr: string; remoteAddr: string }
  | { uplink: 'data'; uid: number; bytes: Uint8Array | null }
  | { uplink: 'written'; uid: number; n: number }
  | { uplink: 'error'; uid: number; message: string; code?: string };

export interface UplinkPeer {
  postMessage(message: UplinkReply, transfer?: Transferable[]): void;
}

export interface UplinkPort {
  postMessage(message: UplinkCall, transfer?: Transferable[]): void;
}

export interface UplinkServer {
  answer(call: UplinkCall): void;
  close(): void;
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

const NEVER = new Routes(true);

export function serveUplink(peer: UplinkPeer, uplink: NetworkUplink): UplinkServer {
  const conns = new Map<number, UplinkConn>();
  const pending = new Map<number, AbortController>();
  let nextCid = 0;
  let closed = false;
  const run = (uid: number, work: (signal: AbortSignal) => Promise<UplinkReply | undefined>) => {
    const abort = new AbortController();
    pending.set(uid, abort);
    void work(abort.signal)
      .then(
        (reply) => reply && peer.postMessage(reply, transferOf(reply)),
        (e: unknown) => peer.postMessage(failure(uid, e))
      )
      .finally(() => pending.delete(uid));
  };
  const conn = (cid: number): UplinkConn => {
    const found = conns.get(cid);
    if (!found) throw Object.assign(new Error('no such uplink connection'), { code: 'EBADF' });
    return found;
  };
  const dial = async (call: Extract<UplinkCall, { uplink: 'dial' }>, signal: AbortSignal) => {
    const kind = NEVER.classify(call.host);
    if (kind === 'loopback' || kind === 'host' || kind === 'reserved') {
      throw Object.assign(new Error(`the uplink does not carry ${call.host}`), {
        code: 'ENETUNREACH',
      });
    }
    const { host, port } = call;
    const opened = await uplink.dial({ network: 'tcp', host, port, signal });
    if (signal.aborted || closed) {
      opened.close();
      return undefined;
    }
    const cid = ++nextCid;
    conns.set(cid, opened);
    const { localAddr, remoteAddr } = opened;
    return { uplink: 'dialled' as const, uid: call.uid, cid, localAddr, remoteAddr };
  };
  const drop = (cid: number) => {
    const found = conns.get(cid);
    conns.delete(cid);
    found?.close();
  };
  return {
    answer(call) {
      switch (call.uplink) {
        case 'resolve':
          return run(call.uid, async (signal) => ({
            uplink: 'resolved',
            uid: call.uid,
            ...answerOf(await uplink.resolve(call.name, call.family, signal)),
          }));
        case 'dial':
          return run(call.uid, (signal) => dial(call, signal));
        case 'cancel':
          return pending.get(call.uid)?.abort();
        case 'read':
          return run(call.uid, async () => ({
            uplink: 'data',
            uid: call.uid,
            bytes: (await conn(call.cid).read()) ?? null,
          }));
        case 'write':
          return run(call.uid, async () => ({
            uplink: 'written',
            uid: call.uid,
            n: await conn(call.cid).write(call.bytes),
          }));
        case 'close-write':
          return conns.get(call.cid)?.closeWrite();
        default:
          return drop(call.cid);
      }
    },
    close() {
      closed = true;
      for (const abort of pending.values()) abort.abort();
      for (const cid of [...conns.keys()]) drop(cid);
    },
  };
}

function transferOf(reply: UplinkReply): Transferable[] | undefined {
  if (reply.uplink !== 'data' || !reply.bytes) return undefined;
  return [reply.bytes.buffer as ArrayBuffer];
}

type Answer = Exclude<UplinkReply, { uplink: 'error' }>;

export class RemoteUplink implements NetworkUplink {
  readonly traits: UplinkTraits;
  readonly routes: RouteTable | undefined;
  private readonly port: UplinkPort;
  private readonly waiting = new Map<number, PromiseWithResolvers<Answer>>();
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
    } else waiter.resolve(reply);
  }

  private ask<T extends Answer>(
    call: Extract<UplinkCall, { uid: number }>,
    signal?: AbortSignal,
    transfer?: Transferable[]
  ): Promise<T> {
    const waiter = Promise.withResolvers<Answer>();
    this.waiting.set(call.uid, waiter);
    signal?.addEventListener(
      'abort',
      () => {
        this.waiting.delete(call.uid);
        this.port.postMessage({ uplink: 'cancel', uid: call.uid });
        waiter.reject(signal.reason);
      },
      { once: true }
    );
    this.port.postMessage(call, transfer);
    return waiter.promise as Promise<T>;
  }

  async resolve(name: string, family: ResolveFamily, signal?: AbortSignal) {
    const reply = await this.ask<Extract<Answer, { uplink: 'resolved' }>>(
      { uplink: 'resolve', uid: ++this.nextId, name, family },
      signal
    );
    return answerOf(reply);
  }

  async dial(req: UplinkDial): Promise<UplinkConn> {
    req.signal.throwIfAborted();
    const { host, port } = req;
    const opened = await this.ask<Extract<Answer, { uplink: 'dialled' }>>(
      { uplink: 'dial', uid: ++this.nextId, host, port },
      req.signal
    );
    const { cid, localAddr, remoteAddr } = opened;
    return {
      localAddr,
      remoteAddr,
      read: async () => {
        const got = await this.ask<Extract<Answer, { uplink: 'data' }>>({
          uplink: 'read',
          uid: ++this.nextId,
          cid,
        });
        return got.bytes;
      },
      write: async (bytes) => {
        const copy = bytes.slice();
        const call = { uplink: 'write' as const, uid: ++this.nextId, cid, bytes: copy };
        const done = await this.ask<Extract<Answer, { uplink: 'written' }>>(call, undefined, [
          copy.buffer,
        ]);
        return done.n;
      },
      closeWrite: () => this.port.postMessage({ uplink: 'close-write', cid }),
      close: () => this.port.postMessage({ uplink: 'close', cid }),
    };
  }
}
