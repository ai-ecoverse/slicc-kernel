import { BODY_IDLE_MS, readWithin } from './body-idle.ts';
import { fresh } from './bytes.ts';
import type { TransportCall, TransportReply } from './kernel/net/remote-transport.ts';
import type {
  HeaderList,
  RealmRedirectHop,
  RealmTransport,
  RealmTransportExit,
  RealmTransportRequest,
  RealmTransportResponse,
  RealmTransportTraits,
  RealmWebSocket,
  RealmWebSocketRequest,
} from './kernel/net/transport.ts';
import { INBOUND_LIMIT, MESSAGE_LIMIT, payloadSize } from './kernel/net/ws-queue.ts';
import { openWebSocket, type WebSocketConstructor } from './websocket-transport.ts';

export type {
  HeaderList,
  RealmRedirectHop as NetworkRedirectHop,
  RealmTransport as NetworkTransport,
  RealmTransportExit as NetworkExit,
  RealmTransportRequest as NetworkRequest,
  RealmTransportResponse as NetworkResponse,
  RealmTransportTraits as NetworkTraits,
  RealmWebSocket as NetworkWebSocket,
  RealmWebSocketRequest as NetworkWebSocketRequest,
};

export interface FetchTransportOptions {
  fetch?: typeof globalThis.fetch;
  maxRequestBody?: number;
  hint?: string;
  bodyIdleMs?: number;
  webSocket?: boolean | WebSocketConstructor;
  webSocketHeaders?: boolean;
  redirect?: 'follow' | 'manual';
  streamingBodies?: boolean;
}

export const SEND_BUFFER = 1024 * 1024;
const CLOSE_WAIT_MS = 5000;
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'ENODATA']);

const NO_WEBSOCKET =
  'WebSocket not supported by this transport (fetchTransport needs { webSocket: true })';

const MAX_REQUEST_BODY = 64 * 1024 * 1024;

function joinHeaders(headers: HeaderList): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    try {
      out.append(name, value);
    } catch {}
  }
  return out;
}

async function* chunks(
  body: ReadableStream<Uint8Array> | null,
  idleMs: number
): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (
      let next = await readWithin(reader, idleMs);
      !next.done;
      next = await readWithin(reader, idleMs)
    ) {
      if (next.value.byteLength > 0) yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function streamOf(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await it.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel(reason) {
        await it.return?.(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

function requestBody(request: RealmTransportRequest): RequestInit {
  if (request.bodyStream) {
    return { body: streamOf(request.bodyStream), duplex: 'half' } as RequestInit;
  }
  return request.body ? { body: request.body as BodyInit } : {};
}

export function fetchTransport(options: FetchTransportOptions = {}): RealmTransport {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const Socket =
    options.webSocket === true
      ? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
      : options.webSocket || undefined;
  const headers = options.webSocketHeaders === true;
  const redirect = options.redirect ?? 'follow';
  return {
    traits: {
      manualRedirects: redirect === 'manual',
      encodedBodies: false,
      maxRequestBody: options.maxRequestBody ?? MAX_REQUEST_BODY,
      crossOrigin: 'cors',
      ...(Socket ? { websocket: true as const } : {}),
      ...(options.streamingBodies ? { streamingBodies: true as const } : {}),
    },
    ...(Socket ? { websocket: (request) => openWebSocket(Socket, request, headers) } : {}),
    async fetch(request: RealmTransportRequest): Promise<RealmTransportResponse> {
      let response: Response;
      try {
        response = await send(request.url, {
          method: request.method,
          headers: joinHeaders(request.headers),
          ...requestBody(request),
          signal: request.signal,
          redirect,
          credentials: 'omit',
          mode: 'cors',
        });
      } catch (e) {
        if (request.signal.aborted) throw e;
        const causeCode = (e as { cause?: { code?: unknown } })?.cause?.code;
        const dns = typeof causeCode === 'string' && DNS_CODES.has(causeCode);
        throw Object.assign(
          new Error(
            `fetch ${request.url} failed (unreachable, or not allowed by CORS)${options.hint ? `: ${options.hint}` : ''}`
          ),
          { status: 502 },
          dns ? { code: causeCode } : {}
        );
      }
      const headers: Array<[string, string]> = [];
      response.headers.forEach((value, name) => {
        headers.push([name, value]);
      });
      const body = chunks(response.body, options.bodyIdleMs ?? BODY_IDLE_MS);
      return {
        ...(response.redirected ? { url: response.url, redirected: true } : {}),
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
        cancel: async () => {
          await body.return(undefined);
          await response.body?.cancel().catch(() => undefined);
        },
      };
    },
  };
}

export interface TransportPeer {
  postMessage(message: TransportReply, transfer?: Transferable[]): void;
}

export interface TransportServer {
  answer(call: TransportCall): void;
  close(): void;
}

interface Flow {
  inflight: number;
  closing: boolean;
  deadline(): void;
  wake?: () => void;
}

function uploadsFor(peer: TransportPeer) {
  const pulls = new Map<number, (call: TransportCall) => void>();
  const of = (nid: number, signal: AbortSignal): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        signal.throwIfAborted();
        const got = await new Promise<TransportCall>((resolve, reject) => {
          const stop = () => reject(signal.reason);
          signal.addEventListener('abort', stop, { once: true });
          pulls.set(nid, (call) => {
            signal.removeEventListener('abort', stop);
            resolve(call);
          });
          peer.postMessage({ net: 'body-pull', nid });
        }).finally(() => pulls.delete(nid));
        if (got.net === 'body-end') return;
        if (got.net === 'body-error') throw new Error(got.message);
        if (got.net === 'body-chunk') yield got.bytes;
      }
    },
  });
  return { of, answer: (call: TransportCall) => pulls.get(call.nid)?.(call) };
}

export function serveTransport(
  peer: TransportPeer,
  transport: RealmTransport,
  { closeWaitMs = CLOSE_WAIT_MS }: { closeWaitMs?: number } = {}
): TransportServer {
  const open = new Map<
    number,
    { abort: AbortController; body?: AsyncIterator<Uint8Array>; response?: RealmTransportResponse }
  >();
  const fail = (nid: number, e: unknown) => {
    open.delete(nid);
    const { status, code } = e as { status?: unknown; code?: unknown };
    peer.postMessage({
      net: 'error',
      nid,
      message: e instanceof Error ? e.message : String(e),
      ...(typeof status === 'number' ? { status } : {}),
      ...(typeof code === 'string' ? { code } : {}),
    });
  };
  const uploads = uploadsFor(peer);
  const start = async (call: Extract<TransportCall, { net: 'fetch' }>) => {
    const abort = new AbortController();
    const entry: { abort: AbortController; body?: AsyncIterator<Uint8Array> } = { abort };
    open.set(call.nid, entry);
    try {
      const response = await transport.fetch({
        url: call.url,
        method: call.method,
        headers: call.headers,
        ...(call.streamed
          ? { bodyStream: uploads.of(call.nid, abort.signal) }
          : call.body
            ? { body: call.body }
            : {}),
        signal: abort.signal,
      });
      if (!open.has(call.nid)) {
        await response.cancel();
        return;
      }
      open.set(call.nid, { abort, body: response.body[Symbol.asyncIterator](), response });
      peer.postMessage({
        net: 'head',
        nid: call.nid,
        ...(response.redirected ? { url: response.url, redirected: true } : {}),
        ...(response.redirects ? { redirects: response.redirects } : {}),
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (e) {
      fail(call.nid, e);
    }
  };
  const sockets = new Map<number, RealmWebSocket>();
  const credit = new Map<number, Flow>();
  const refill = (nid: number, n: number, closing = false) => {
    const flow = credit.get(nid);
    if (!flow) return;
    flow.inflight -= n;
    if (closing && !flow.closing) {
      flow.closing = true;
      flow.deadline();
    }
    flow.wake?.();
  };
  const openSocket = async (call: Extract<TransportCall, { net: 'ws-open' }>) => {
    const abort = new AbortController();
    open.set(call.nid, { abort });
    try {
      if (!transport.websocket) throw new Error(NO_WEBSOCKET);
      const socket = await transport.websocket({
        url: call.url,
        protocols: call.protocols,
        headers: call.headers,
        signal: abort.signal,
      });
      if (!open.delete(call.nid)) {
        socket.close(1000, 'cancelled');
        return;
      }
      sockets.set(call.nid, socket);
      peer.postMessage({ net: 'ws-opened', nid: call.nid, protocol: socket.protocol });
      void relay(call.nid, socket);
    } catch (e) {
      fail(call.nid, e);
    }
  };
  const relay = async (nid: number, socket: RealmWebSocket) => {
    let ending: { code: number; reason: string };
    let late!: () => void;
    const unanswered = new Promise<'late'>((resolve) => {
      late = () => resolve('late');
    });
    const flow: Flow = {
      inflight: 0,
      closing: false,
      deadline: () =>
        AbortSignal.timeout(closeWaitMs).addEventListener('abort', late, { once: true }),
    };
    credit.set(nid, flow);
    const timedOut = { code: 1006, reason: 'the far end did not answer the close' };
    let oversize = false;
    try {
      const messages = socket.messages[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([messages.next(), unanswered]);
        if (next === 'late' || next.done) break;
        const data = next.value;
        if (flow.closing) continue;
        if (payloadSize(data) > MESSAGE_LIMIT) {
          oversize = true;
          break;
        }
        if (typeof data === 'string') peer.postMessage({ net: 'ws-message', nid, data });
        else {
          const bytes = fresh(data);
          peer.postMessage({ net: 'ws-message', nid, data: bytes }, [bytes.buffer]);
        }
        flow.inflight += payloadSize(data);
        while (flow.inflight > INBOUND_LIMIT && !flow.closing) {
          await new Promise<void>((resolve) => {
            flow.wake = resolve;
          });
        }
      }
      if (oversize) socket.close(1000, 'a message is too big');
      ending = oversize
        ? { code: 1009, reason: `a message is over ${MESSAGE_LIMIT} bytes` }
        : await Promise.race([socket.closed, unanswered.then(() => timedOut)]);
    } catch (e) {
      socket.close(1000, 'the relay failed');
      ending = { code: 1011, reason: e instanceof Error ? e.message : String(e) };
    }
    sockets.delete(nid);
    credit.delete(nid);
    peer.postMessage({ net: 'ws-closed', nid, ...ending });
  };
  const sendOn = async (call: Extract<TransportCall, { net: 'ws-send' }>) => {
    const socket = sockets.get(call.nid);
    if (!socket) return;
    socket.send(call.data);
    while (socket.buffered > SEND_BUFFER && sockets.has(call.nid)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    peer.postMessage({ net: 'ws-acked', nid: call.nid, n: payloadSize(call.data) });
  };
  const read = async (nid: number) => {
    const body = open.get(nid)?.body;
    if (!body) return;
    try {
      const next = await body.next();
      if (next.done) {
        open.delete(nid);
        peer.postMessage({ net: 'end', nid });
      } else {
        const bytes = fresh(next.value);
        peer.postMessage({ net: 'chunk', nid, bytes }, [bytes.buffer]);
      }
    } catch (e) {
      fail(nid, e);
    }
  };
  const drop = (nid: number) => {
    sockets.get(nid)?.close(1000, 'cancelled');
    refill(nid, 0, true);
    const entry = open.get(nid);
    open.delete(nid);
    entry?.abort.abort();
    void entry?.response?.cancel().catch(() => undefined);
  };
  return {
    answer(call) {
      if (call.net === 'fetch') void start(call);
      else if (call.net === 'body-chunk' || call.net === 'body-end' || call.net === 'body-error') {
        uploads.answer(call);
      } else if (call.net === 'read') void read(call.nid);
      else if (call.net === 'ws-open') void openSocket(call);
      else if (call.net === 'ws-send') void sendOn(call);
      else if (call.net === 'ws-close') {
        sockets.get(call.nid)?.close(call.code, call.reason);
        refill(call.nid, 0, true);
      } else if (call.net === 'ws-consumed') refill(call.nid, call.n);
      else drop(call.nid);
    },
    close() {
      for (const nid of [...open.keys(), ...sockets.keys()]) drop(nid);
    },
  };
}
