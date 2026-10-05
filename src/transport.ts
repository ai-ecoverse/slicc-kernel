import type { TransportCall, TransportReply } from './kernel/net/remote-transport.ts';
import type {
  HeaderList,
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
  RealmTransportTraits,
} from './kernel/net/transport.ts';

export type {
  HeaderList,
  RealmTransport as NetworkTransport,
  RealmTransportRequest as NetworkRequest,
  RealmTransportResponse as NetworkResponse,
  RealmTransportTraits as NetworkTraits,
};

export interface FetchTransportOptions {
  fetch?: typeof globalThis.fetch;
  maxRequestBody?: number;
  hint?: string;
}

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

async function* chunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      if (next.value.byteLength > 0) yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function fetchTransport(options: FetchTransportOptions = {}): RealmTransport {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    traits: {
      manualRedirects: false,
      encodedBodies: false,
      maxRequestBody: options.maxRequestBody ?? MAX_REQUEST_BODY,
      crossOrigin: 'cors',
    },
    async fetch(request: RealmTransportRequest): Promise<RealmTransportResponse> {
      let response: Response;
      try {
        response = await send(request.url, {
          method: request.method,
          headers: joinHeaders(request.headers),
          ...(request.body ? { body: request.body as BodyInit } : {}),
          signal: request.signal,
          redirect: 'follow',
          credentials: 'omit',
          mode: 'cors',
        });
      } catch (e) {
        if (request.signal.aborted) throw e;
        throw Object.assign(
          new Error(
            `fetch ${request.url} failed (unreachable, or not allowed by CORS)${options.hint ? `: ${options.hint}` : ''}`
          ),
          { status: 502 }
        );
      }
      const headers: Array<[string, string]> = [];
      response.headers.forEach((value, name) => {
        headers.push([name, value]);
      });
      const body = chunks(response.body);
      return {
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

export function serveTransport(peer: TransportPeer, transport: RealmTransport): TransportServer {
  const open = new Map<
    number,
    { abort: AbortController; body?: AsyncIterator<Uint8Array>; response?: RealmTransportResponse }
  >();
  const fail = (nid: number, e: unknown) => {
    open.delete(nid);
    const status = (e as { status?: unknown }).status;
    peer.postMessage({
      net: 'error',
      nid,
      message: e instanceof Error ? e.message : String(e),
      ...(typeof status === 'number' ? { status } : {}),
    });
  };
  const start = async (call: Extract<TransportCall, { net: 'fetch' }>) => {
    const abort = new AbortController();
    const entry: { abort: AbortController; body?: AsyncIterator<Uint8Array> } = { abort };
    open.set(call.nid, entry);
    try {
      const response = await transport.fetch({
        url: call.url,
        method: call.method,
        headers: call.headers,
        ...(call.body ? { body: call.body } : {}),
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
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (e) {
      fail(call.nid, e);
    }
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
        const bytes = next.value.slice();
        peer.postMessage({ net: 'chunk', nid, bytes }, [bytes.buffer]);
      }
    } catch (e) {
      fail(nid, e);
    }
  };
  const drop = (nid: number) => {
    const entry = open.get(nid);
    open.delete(nid);
    entry?.abort.abort();
    void entry?.response?.cancel().catch(() => undefined);
  };
  return {
    answer(call) {
      if (call.net === 'fetch') void start(call);
      else if (call.net === 'read') void read(call.nid);
      else drop(call.nid);
    },
    close() {
      for (const nid of [...open.keys()]) drop(nid);
    },
  };
}
