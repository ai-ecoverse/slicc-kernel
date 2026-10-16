import {
  acceptFor,
  CLOSE,
  clientFrame,
  OP_BINARY,
  OP_TEXT,
  sendableCode,
  WsError,
  WsReader,
} from '../../cdp/websocket.ts';
import { KernelError } from '../fd-table.ts';
import type { ConnectorStamp, KernelSocket, LoopbackNet, PeerCred } from '../socket.ts';
import { concat, fieldTokens, fieldValues, Incoming, latin1, latin1Bytes } from './http1.ts';
import { kernelLoopbackPort } from './loopback-names.ts';
import type {
  HeaderList,
  RealmTransportRequest,
  RealmTransportResponse,
  RealmTransportTraits,
  RealmWebSocket,
  RealmWebSocketClose,
  RealmWebSocketMessage,
  RealmWebSocketRequest,
} from './transport.ts';

export const LOOPBACK_TRAITS: RealmTransportTraits = {
  manualRedirects: true,
  encodedBodies: true,
  maxRequestBody: 64 * 1024 * 1024,
  crossOrigin: 'any',
  websocket: true,
};

const MAX_HEAD = 64 * 1024;
const OWN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]);
const OP_CLOSE = 8;
const OP_PONG = 10;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SAFE_VALUE = /^[^\r\n\0]*$/;
const CLOSE_WAIT_MS = 5000;
const MAX_UNREAD = 16 * 1024 * 1024;

function errno(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function requestHead(
  method: string,
  url: URL,
  headers: HeaderList,
  extra: ReadonlyArray<readonly [string, string]>
): Uint8Array {
  if (!TOKEN.test(method)) throw errno('EINVAL', `method ${method}`);
  const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`];
  for (const [name, value] of headers) {
    if (OWN_HEADERS.has(name.toLowerCase())) continue;
    if (!TOKEN.test(name) || !SAFE_VALUE.test(value)) throw errno('EINVAL', `header ${name}`);
    lines.push(`${name}: ${value}`);
  }
  for (const [name, value] of extra) lines.push(`${name}: ${value}`);
  return latin1Bytes(`${lines.join('\r\n')}\r\n\r\n`);
}

interface ResponseHead {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

function parseHead(bytes: Uint8Array): ResponseHead {
  const [statusLine = '', ...lines] = latin1(bytes).split(/\r?\n/);
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!match) throw errno('EPROTO', `not an HTTP/1.x response: ${statusLine.slice(0, 80)}`);
  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { status: Number(match[1]), statusText: match[2] ?? '', headers };
}

async function readHead(incoming: Incoming, signal: AbortSignal): Promise<ResponseHead> {
  for (;;) {
    let raw: Uint8Array | null;
    try {
      raw = await incoming.head(MAX_HEAD, signal);
    } catch (err) {
      if (err instanceof KernelError) throw err;
      throw errno('EPROTO', 'the response head is malformed or too large');
    }
    if (!raw) throw errno('ECONNRESET', 'the connection closed before a response');
    const head = parseHead(raw);
    if (head.status < 100 || head.status >= 200 || head.status === 101) return head;
  }
}

async function* chunked(incoming: Incoming, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  for (;;) {
    const line = await incoming.line(4096, signal);
    const size = /^([0-9A-Fa-f]{1,12})[ \t]*(;.*)?$/.exec(line);
    if (!size) throw errno('EPROTO', 'a malformed chunk size');
    const n = Number.parseInt(size[1] as string, 16);
    if (n === 0) {
      while ((await incoming.line(MAX_HEAD, signal)) !== '');
      return;
    }
    yield await incoming.exactly(n, signal);
    if ((await incoming.line(2, signal)) !== '') throw errno('EPROTO', 'a malformed chunk');
  }
}

async function* counted(
  incoming: Incoming,
  length: number,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  for (let left = length; left > 0; ) {
    const data = await incoming.some(Math.min(left, 64 * 1024), signal);
    if (data.length === 0) throw errno('EPROTO', 'the body ended early');
    left -= data.length;
    yield data;
  }
}

async function* untilClose(incoming: Incoming, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  for (;;) {
    const data = await incoming.some(64 * 1024, signal);
    if (data.length === 0) return;
    yield data;
  }
}

function bodyOf(
  incoming: Incoming,
  head: ResponseHead,
  method: string,
  signal: AbortSignal
): AsyncIterable<Uint8Array> | Iterable<Uint8Array> {
  if (method === 'HEAD' || head.status === 204 || head.status === 304) return [];
  if (fieldTokens(head.headers, 'transfer-encoding').includes('chunked')) {
    return chunked(incoming, signal);
  }
  const lengths = fieldValues(head.headers, 'content-length');
  if (lengths.length === 0) return untilClose(incoming, signal);
  const length = lengths[0]?.trim() ?? '';
  if (!/^\d{1,15}$/.test(length) || lengths.some((l) => l.trim() !== length)) {
    throw errno('EPROTO', `a malformed Content-Length: ${lengths.join(', ')}`);
  }
  return counted(incoming, Number(length), signal);
}

export class KernelLoopback {
  private readonly net: LoopbackNet;
  private readonly cred: () => PeerCred;
  private readonly stamp?: () => Promise<ConnectorStamp>;

  constructor(net: LoopbackNet, cred: () => PeerCred, stamp?: () => Promise<ConnectorStamp>) {
    this.net = net;
    this.cred = cred;
    this.stamp = stamp;
  }

  port(url: string): number | undefined {
    return kernelLoopbackPort(url);
  }

  private async connect(url: URL, port: number, signal: AbortSignal): Promise<KernelSocket> {
    if (url.protocol === 'https:' || url.protocol === 'wss:') {
      throw errno('ENOTSUP', `TLS to the kernel's loopback is not supported: ${url.origin}`);
    }
    signal.throwIfAborted();
    const socket = this.net.socket('inet');
    try {
      void socket.connect(
        { family: 'inet', host: '127.0.0.1', port },
        false,
        this.cred(),
        this.stamp ? await this.stamp() : undefined,
        false
      );
    } catch (err) {
      socket.close();
      const refused = err instanceof KernelError && err.code === 'ECONNREFUSED';
      throw refused ? errno('ECONNREFUSED', `nothing listens on the kernel's port ${port}`) : err;
    }
    signal.addEventListener('abort', () => socket.close(), { once: true });
    return socket;
  }

  async fetch(req: RealmTransportRequest, port: number): Promise<RealmTransportResponse> {
    const url = new URL(req.url);
    const body =
      req.body ?? (/^(POST|PUT|PATCH)$/i.test(req.method) ? new Uint8Array(0) : undefined);
    const length: Array<[string, string]> = body ? [['Content-Length', String(body.length)]] : [];
    const head = requestHead(req.method, url, req.headers, [...length, ['Connection', 'close']]);
    const socket = await this.connect(url, port, req.signal);
    try {
      await writeAll(socket, body ? concat([head, body]) : head, req.signal);
      const incoming = new Incoming(socket);
      const response = await readHead(incoming, req.signal);
      const chunks = bodyOf(incoming, response, req.method, req.signal);
      return {
        url: req.url,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: closing(chunks, socket),
        cancel: async () => socket.close(),
      };
    } catch (err) {
      socket.close();
      throw err;
    }
  }

  async websocket(req: RealmWebSocketRequest, port: number): Promise<RealmWebSocket> {
    const url = new URL(req.url);
    const socket = await this.connect(url, port, req.signal);
    try {
      const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const extra: Array<[string, string]> = [
        ['Upgrade', 'websocket'],
        ['Connection', 'Upgrade'],
        ['Sec-WebSocket-Key', key],
        ['Sec-WebSocket-Version', '13'],
      ];
      if (req.protocols.length > 0)
        extra.push(['Sec-WebSocket-Protocol', req.protocols.join(', ')]);
      await writeAll(socket, requestHead('GET', url, req.headers, extra), req.signal);
      const incoming = new Incoming(socket);
      const head = await readHead(incoming, req.signal);
      if (head.status !== 101) {
        throw errno(
          'EPROTO',
          `the server answered the upgrade with ${head.status}${head.statusText ? ` ${head.statusText}` : ''}`
        );
      }
      const upgraded =
        fieldTokens(head.headers, 'upgrade').includes('websocket') &&
        fieldTokens(head.headers, 'connection').includes('upgrade');
      const accept = fieldValues(head.headers, 'sec-websocket-accept')[0];
      if (!upgraded || accept !== (await acceptFor(key))) {
        throw errno('EPROTO', 'the server did not accept the WebSocket key');
      }
      if (fieldValues(head.headers, 'sec-websocket-extensions').length > 0) {
        throw errno('EPROTO', 'the server offered an unsolicited extension');
      }
      const protocol = fieldValues(head.headers, 'sec-websocket-protocol')[0] ?? '';
      return new LoopbackWebSocket(socket, incoming, protocol);
    } catch (err) {
      socket.close();
      throw err;
    }
  }
}

async function writeAll(
  socket: KernelSocket,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  for (let at = 0; at < bytes.length; ) at += await socket.write(bytes.subarray(at), signal);
}

async function* closing(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  socket: KernelSocket
): AsyncGenerator<Uint8Array> {
  try {
    yield* chunks;
  } catch (err) {
    if (typeof (err as { code?: unknown } | null)?.code === 'string') throw err;
    throw errno('EPROTO', err instanceof Error ? err.message : String(err));
  } finally {
    socket.close();
  }
}

class LoopbackWebSocket implements RealmWebSocket {
  readonly protocol: string;
  readonly messages: AsyncIterable<RealmWebSocketMessage>;
  readonly closed: Promise<RealmWebSocketClose>;
  private pending = 0;
  private writes: Promise<void> = Promise.resolve();
  private sentClose = false;
  private readonly stop = new AbortController();
  private readonly socket: KernelSocket;
  private settle!: (close: RealmWebSocketClose) => void;
  private unread = 0;
  private room: (() => void) | undefined;

  constructor(socket: KernelSocket, incoming: Incoming, protocol: string) {
    this.socket = socket;
    this.protocol = protocol;
    this.closed = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.stop.signal.addEventListener('abort', () => this.room?.(), { once: true });
    const queue: RealmWebSocketMessage[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    void this.pump(new WsReader(incoming, undefined, true, true), (message) => {
      queue.push(message);
      this.unread += message.length;
      wake?.();
    }).finally(() => {
      ended = true;
      wake?.();
    });
    const taken = (message: RealmWebSocketMessage): void => {
      this.unread -= message.length;
      const room = this.room;
      this.room = undefined;
      room?.();
    };
    this.messages = {
      [Symbol.asyncIterator]: async function* () {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            taken(next);
            yield next;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      },
    };
  }

  private async space(): Promise<void> {
    while (this.unread > MAX_UNREAD && !this.stop.signal.aborted) {
      await new Promise<void>((resolve) => {
        this.room = resolve;
      });
    }
  }

  get buffered(): number {
    return this.pending;
  }

  private write(bytes: Uint8Array): void {
    this.pending += bytes.length;
    const previous = this.writes;
    this.writes = (async () => {
      await previous;
      try {
        await writeAll(this.socket, bytes, this.stop.signal);
      } catch {
        this.stop.abort();
      }
      this.pending -= bytes.length;
    })();
  }

  private async pump(
    reader: WsReader<true>,
    deliver: (message: RealmWebSocketMessage) => void
  ): Promise<void> {
    let close: RealmWebSocketClose = { code: 1006, reason: '', wasClean: false };
    try {
      for (;;) {
        await this.space();
        const event = await reader.next(this.stop.signal);
        if (!event) break;
        if (event.kind === 'text') deliver(event.text);
        else if (event.kind === 'binary') deliver(event.bytes);
        else if (event.kind === 'ping') this.write(clientFrame(OP_PONG, event.payload));
        else {
          close = { code: event.code, reason: event.reason, wasClean: true };
          if (!this.sentClose) this.sendClose(event.code === 1005 ? 1000 : event.code, '');
          break;
        }
      }
    } catch (err) {
      if (err instanceof WsError) this.sendClose(err.code, err.message);
      close = { code: 1006, reason: '', wasClean: false };
    } finally {
      const late = setTimeout(() => this.stop.abort(), CLOSE_WAIT_MS);
      await this.writes;
      clearTimeout(late);
      this.socket.close();
      this.settle(close);
    }
  }

  private sendClose(code: number, reason: string): void {
    if (this.sentClose) return;
    this.sentClose = true;
    const late = setTimeout(() => this.stop.abort(), CLOSE_WAIT_MS);
    void this.closed.then(() => clearTimeout(late));
    const bytes = new TextEncoder().encode(reason).subarray(0, 123);
    const payload = new Uint8Array(2 + bytes.length);
    new DataView(payload.buffer).setUint16(0, sendableCode(code) ? code : CLOSE.error);
    payload.set(bytes, 2);
    this.write(clientFrame(OP_CLOSE, payload));
  }

  send(data: RealmWebSocketMessage): void {
    if (this.sentClose) throw errno('EPIPE', 'the websocket is closing');
    const text = typeof data === 'string';
    const payload = text ? new TextEncoder().encode(data) : data;
    this.write(clientFrame(text ? OP_TEXT : OP_BINARY, payload));
  }

  close(code = 1000, reason = ''): void {
    this.sendClose(code, reason);
  }
}
