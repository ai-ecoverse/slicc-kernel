import { Routes, type RouteTable } from './routes.ts';

export interface UplinkTraits {
  tcp: true;
  udp: boolean;
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

export interface UplinkDatagram {
  bytes: Uint8Array;
  host: string;
  port: number;
}

export interface UplinkUnreachable {
  error: string;
  host: string;
  port: number;
}

export type UplinkMessage = UplinkDatagram | UplinkUnreachable;

export interface UplinkUdpOpen {
  family: 4 | 6;
  signal: AbortSignal;
}

export interface UplinkUdp {
  readonly localAddr: string;
  send(bytes: Uint8Array, host: string, port: number): Promise<void>;
  readonly messages: AsyncIterable<UplinkMessage>;
  close(): void;
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
  udp?(req: UplinkUdpOpen): Promise<UplinkUdp>;
}

export function carriesUdp(uplink: NetworkUplink): boolean {
  return uplink.traits.udp === true && typeof uplink.udp === 'function';
}

export type UplinkCall =
  | { uplink: 'resolve'; uid: number; name: string; family: ResolveFamily }
  | { uplink: 'dial'; uid: number; host: string; port: number }
  | { uplink: 'cancel'; uid: number }
  | { uplink: 'read'; uid: number; cid: number }
  | { uplink: 'write'; uid: number; cid: number; bytes: Uint8Array }
  | { uplink: 'close-write'; cid: number }
  | { uplink: 'close'; cid: number }
  | { uplink: 'udp-open'; uid: number; family: 4 | 6 }
  | { uplink: 'udp-send'; uid: number; cid: number; bytes: Uint8Array; host: string; port: number }
  | { uplink: 'udp-recv'; uid: number; cid: number }
  | { uplink: 'udp-close'; cid: number };

export type UplinkReply =
  | { uplink: 'resolved'; uid: number; addresses: string[]; ttl?: number }
  | { uplink: 'dialled'; uid: number; cid: number; localAddr: string; remoteAddr: string }
  | { uplink: 'data'; uid: number; bytes: Uint8Array | null }
  | { uplink: 'written'; uid: number; n: number }
  | { uplink: 'udp-opened'; uid: number; cid: number; localAddr: string }
  | { uplink: 'udp-sent'; uid: number }
  | { uplink: 'udp-message'; uid: number; message: UplinkMessage | null }
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
    refuseLocal(call.host);
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
  const udp = new UdpServer(uplink, () => closed);
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
            bytes: (await conn(call.cid).read())?.slice() ?? null,
          }));
        case 'write':
          return run(call.uid, async () => ({
            uplink: 'written',
            uid: call.uid,
            n: await conn(call.cid).write(call.bytes),
          }));
        case 'close-write':
          return conns.get(call.cid)?.closeWrite();
        case 'close':
          return drop(call.cid);
        case 'udp-close':
          return udp.drop(call.cid);
        default:
          return run(call.uid, (signal) => udp.answer(call, signal));
      }
    },
    close() {
      closed = true;
      for (const abort of pending.values()) abort.abort();
      for (const cid of [...conns.keys()]) drop(cid);
      udp.close();
    },
  };
}

function copied(message: UplinkMessage): UplinkMessage {
  if ('bytes' in message) return { ...message, bytes: message.bytes.slice() };
  return { error: String(message.error), host: message.host, port: message.port };
}

function refuseLocal(host: string): void {
  const kind = NEVER.classify(host);
  if (kind === 'loopback' || kind === 'host' || kind === 'reserved') {
    throw Object.assign(new Error(`the uplink does not carry ${host}`), { code: 'ENETUNREACH' });
  }
}

type UdpCall = Extract<UplinkCall, { uplink: 'udp-open' | 'udp-send' | 'udp-recv' }>;

class UdpServer {
  private readonly sockets = new Map<
    number,
    { udp: UplinkUdp; messages: AsyncIterator<UplinkMessage> }
  >();
  private next = 0;
  private readonly uplink: NetworkUplink;
  private readonly closed: () => boolean;

  constructor(uplink: NetworkUplink, closed: () => boolean) {
    this.uplink = uplink;
    this.closed = closed;
  }

  private socket(cid: number) {
    const found = this.sockets.get(cid);
    if (!found) throw Object.assign(new Error('no such uplink socket'), { code: 'EBADF' });
    return found;
  }

  async answer(call: UdpCall, signal: AbortSignal): Promise<UplinkReply | undefined> {
    if (call.uplink === 'udp-open') {
      if (!this.uplink.udp || this.uplink.traits.udp !== true) {
        throw Object.assign(new Error('the uplink carries no datagrams'), { code: 'ENETUNREACH' });
      }
      const opened = await this.uplink.udp({ family: call.family, signal });
      if (signal.aborted || this.closed()) {
        opened.close();
        return undefined;
      }
      const cid = ++this.next;
      this.sockets.set(cid, { udp: opened, messages: opened.messages[Symbol.asyncIterator]() });
      return { uplink: 'udp-opened', uid: call.uid, cid, localAddr: opened.localAddr };
    }
    if (call.uplink === 'udp-send') {
      refuseLocal(call.host);
      await this.socket(call.cid).udp.send(call.bytes, call.host, call.port);
      return { uplink: 'udp-sent', uid: call.uid };
    }
    const next = await this.socket(call.cid).messages.next();
    const message = next.done ? null : copied(next.value);
    return { uplink: 'udp-message', uid: call.uid, message };
  }

  drop(cid: number): void {
    const found = this.sockets.get(cid);
    this.sockets.delete(cid);
    found?.udp.close();
  }

  close(): void {
    for (const cid of [...this.sockets.keys()]) this.drop(cid);
  }
}

function transferOf(reply: UplinkReply): Transferable[] | undefined {
  if (reply.uplink === 'udp-message' && reply.message && 'bytes' in reply.message) {
    return [reply.message.bytes.buffer as ArrayBuffer];
  }
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
    const abort = () => {
      this.waiting.delete(call.uid);
      this.port.postMessage({ uplink: 'cancel', uid: call.uid });
      waiter.reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const settled = () => signal?.removeEventListener('abort', abort);
    waiter.promise.then(settled, settled);
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

  async udp(req: UplinkUdpOpen): Promise<UplinkUdp> {
    req.signal.throwIfAborted();
    const opened = await this.ask<Extract<Answer, { uplink: 'udp-opened' }>>(
      { uplink: 'udp-open', uid: ++this.nextId, family: req.family },
      req.signal
    );
    const { cid, localAddr } = opened;
    const recv = () =>
      this.ask<Extract<Answer, { uplink: 'udp-message' }>>({
        uplink: 'udp-recv',
        uid: ++this.nextId,
        cid,
      });
    return {
      localAddr,
      send: async (bytes, host, port) => {
        const copy = bytes.slice();
        const call = {
          uplink: 'udp-send' as const,
          uid: ++this.nextId,
          cid,
          bytes: copy,
          host,
          port,
        };
        await this.ask(call, undefined, [copy.buffer]);
      },
      messages: {
        [Symbol.asyncIterator]: async function* () {
          for (;;) {
            const got = await recv();
            if (!got.message) return;
            yield got.message;
          }
        },
      },
      close: () => this.port.postMessage({ uplink: 'udp-close', cid }),
    };
  }
}
