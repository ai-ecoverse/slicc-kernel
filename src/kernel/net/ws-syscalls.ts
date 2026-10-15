import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import { toHostLoopback } from './loopback-names.ts';
import type { KernelLoopback } from './loopback-transport.ts';
import { NO_WEBSOCKET } from './proxy-service.ts';
import type { HeaderList, RealmTransport, RealmWebSocket } from './transport.ts';

export type WsSyscall =
  | { op: 'net-ws-open'; url: string; protocols: string[]; headers: HeaderList }
  | { op: 'net-ws-ready'; handle: number }
  | { op: 'net-ws-recv'; handle: number }
  | { op: 'net-ws-wait'; handle: number }
  | { op: 'net-ws-send'; handle: number; text?: string; body?: Uint8Array }
  | { op: 'net-ws-close'; handle: number; code?: number; reason?: string };

export const WS_OPS: readonly string[] = [
  'net-ws-open',
  'net-ws-ready',
  'net-ws-recv',
  'net-ws-wait',
  'net-ws-send',
  'net-ws-close',
];

interface OpenSocket {
  abort: AbortController;
  ready: Promise<SyncFsResult>;
  socket?: RealmWebSocket;
  messages?: AsyncIterator<string | Uint8Array>;
  ended?: boolean;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const ERRNO = /^E[A-Z]+$|^EAI_[A-Z]+$/;

function errnoOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERRNO.test(code) ? code : 'ECONNREFUSED';
}

function fail(errno: string, text: string): SyncFsResult {
  return { ok: false, errno, message: text };
}

export class WsHandles {
  private readonly transport: RealmTransport;
  private readonly open = new Map<number, OpenSocket>();
  private readonly next: () => number;
  private readonly local: KernelLoopback | undefined;

  constructor(transport: RealmTransport, next: () => number, local?: KernelLoopback) {
    this.transport = transport;
    this.next = next;
    this.local = local;
  }

  owns(handle: number): boolean {
    return this.open.has(handle);
  }

  syscall(req: WsSyscall): Promise<SyncFsResult> {
    if (req.op === 'net-ws-open') return Promise.resolve(this.start(req));
    const entry = this.open.get(req.handle);
    if (!entry) return Promise.resolve(fail('EBADF', `no websocket ${req.handle}`));
    if (req.op === 'net-ws-ready') return entry.ready;
    if (!entry.socket) return Promise.resolve(fail('ENOTCONN', 'websocket not open'));
    if (req.op === 'net-ws-recv') return this.recv(entry.socket, entry);
    if (req.op === 'net-ws-wait') return this.closed(entry.socket);
    if (req.op === 'net-ws-send') return Promise.resolve(this.send(entry.socket, req, entry));
    entry.ended = true;
    entry.socket.close(req.code ?? 1000, req.reason ?? '');
    return Promise.resolve({ ok: true, kind: 'void' });
  }

  private start(req: Extract<WsSyscall, { op: 'net-ws-open' }>): SyncFsResult {
    const handle = this.next();
    const entry: OpenSocket = {
      abort: new AbortController(),
      ready: Promise.resolve({ ok: true, kind: 'void' }),
    };
    this.open.set(handle, entry);
    entry.ready = this.connect(handle, req, entry);
    return { ok: true, kind: 'json', json: handle };
  }

  private async connect(
    handle: number,
    req: Extract<WsSyscall, { op: 'net-ws-open' }>,
    entry: OpenSocket
  ): Promise<SyncFsResult> {
    const { transport, local } = this;
    const port = local?.port(req.url);
    const open = { protocols: req.protocols, headers: req.headers, signal: entry.abort.signal };
    if (port === undefined && (!transport.traits.websocket || !transport.websocket)) {
      return fail('ENOTSUP', NO_WEBSOCKET);
    }
    let socket: RealmWebSocket;
    try {
      socket =
        port === undefined
          ? await (transport.websocket as NonNullable<RealmTransport['websocket']>)({
              url: toHostLoopback(req.url),
              ...open,
            })
          : await (local as KernelLoopback).websocket({ url: req.url, ...open }, port);
    } catch (e) {
      return fail(errnoOf(e), message(e));
    }
    if (!this.open.has(handle)) {
      socket.close(1001, 'the program went away');
      return fail('EBADF', `no websocket ${handle}`);
    }
    if (
      socket.protocol &&
      !(req.protocols.includes(socket.protocol) && TOKEN.test(socket.protocol))
    ) {
      socket.close(1002, 'subprotocol not offered');
      return fail('EPROTO', 'the far end chose a subprotocol the program did not offer');
    }
    entry.socket = socket;
    void socket.closed.then(() => {
      entry.ended = true;
    });
    entry.messages = socket.messages[Symbol.asyncIterator]();
    return { ok: true, kind: 'json', json: { protocol: socket.protocol } };
  }

  private async recv(socket: RealmWebSocket, entry: OpenSocket): Promise<SyncFsResult> {
    try {
      const next = await (entry.messages as AsyncIterator<string | Uint8Array>).next();
      if (!next.done) {
        return typeof next.value === 'string'
          ? { ok: true, kind: 'json', json: { text: next.value } }
          : { ok: true, kind: 'bytes', bytes: next.value };
      }
      const closed = await socket.closed;
      return { ok: true, kind: 'json', json: { code: closed.code, reason: closed.reason } };
    } catch (e) {
      return fail('ECONNRESET', message(e));
    }
  }

  private async closed(socket: RealmWebSocket): Promise<SyncFsResult> {
    const { code, reason } = await socket.closed;
    return { ok: true, kind: 'json', json: { code, reason } };
  }

  private send(
    socket: RealmWebSocket,
    req: Extract<WsSyscall, { op: 'net-ws-send' }>,
    entry: OpenSocket
  ) {
    const data = req.text ?? req.body;
    if (entry.ended) return fail('EPIPE', 'the websocket is closed');
    try {
      if (data !== undefined) socket.send(data);
    } catch (e) {
      return fail('EPIPE', message(e));
    }
    return { ok: true, kind: 'json', json: socket.buffered } as const;
  }

  close(handle: number): void {
    const entry = this.open.get(handle);
    if (!entry) return;
    this.open.delete(handle);
    entry.abort.abort();
    entry.socket?.close(1001, 'the program went away');
  }

  closeAll(): void {
    for (const handle of [...this.open.keys()]) this.close(handle);
  }
}
