import type {
  HeaderList,
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
} from './kernel/net/transport.ts';

export interface LocalProxyOptions {
  url: string;
  key: string;
  fetch?: typeof globalThis.fetch;
}

export interface LocalProxyTransportOptions extends LocalProxyOptions {
  maxRequestBody?: number;
}

export interface LocalProxyProbe {
  rawFetch: number;
  requestBodyStreaming: boolean;
  maxRequestBodyBytes: number;
}

const PATH = '/api/fetch-proxy';
const RAW_CONTENT_TYPE = 'application/vnd.slicc.raw-fetch';
const MAX_HEAD = 1024 * 1024;
const MAX_REQUEST_BODY = 64 * 1024 * 1024;

interface ResponseHead {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

const failure = (message: string, status = 502) =>
  Object.assign(new Error(`local proxy: ${message}`), { status });

function encodeHead(url: string, method: string, headers: HeaderList): string {
  return JSON.stringify({ url, method, headers }).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function hopHeaders(options: LocalProxyOptions, extra: Record<string, string>): Headers {
  return new Headers({ 'X-Bridge-Token': options.key, ...extra });
}

function send(options: LocalProxyOptions) {
  return options.fetch ?? globalThis.fetch.bind(globalThis);
}

async function refusal(response: Response): Promise<Error> {
  const text = await response.text().catch(() => '');
  let message = text || response.statusText || `answered ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') message = parsed.error;
  } catch {}
  return failure(message, response.ok ? 502 : response.status);
}

function isHead(value: unknown): value is ResponseHead {
  const head = value as Partial<ResponseHead> | null;
  return (
    !!head &&
    typeof head.status === 'number' &&
    typeof head.statusText === 'string' &&
    Array.isArray(head.headers) &&
    head.headers.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string'
    )
  );
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

async function readHead(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ head: ResponseHead; rest: Uint8Array }> {
  let buffer: Uint8Array = new Uint8Array(0);
  for (;;) {
    if (buffer.byteLength >= 4) {
      const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
      if (length > MAX_HEAD) throw failure(`response head of ${length} bytes`);
      if (buffer.byteLength >= 4 + length) {
        let head: unknown;
        try {
          head = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length)));
        } catch {}
        if (!isHead(head)) throw failure('malformed response head');
        return { head, rest: buffer.subarray(4 + length) };
      }
    }
    const next = await reader.read();
    if (next.done) throw failure('closed before the response head');
    buffer = concat(buffer, next.value);
  }
}

async function* chunks(
  rest: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<Uint8Array> {
  try {
    if (rest.byteLength > 0) yield rest;
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      if (next.value.byteLength > 0) yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function probeLocalProxy(options: LocalProxyOptions): Promise<LocalProxyProbe | null> {
  try {
    const response = await send(options)(new URL(PATH, options.url), {
      method: 'POST',
      headers: hopHeaders(options, { 'X-Slicc-Raw-Probe': '1' }),
      credentials: 'omit',
      mode: 'cors',
    });
    if (!response.ok) return null;
    const reply = (await response.json()) as Partial<LocalProxyProbe>;
    if (typeof reply.rawFetch !== 'number' || reply.rawFetch < 1) return null;
    if (typeof reply.requestBodyStreaming !== 'boolean') return null;
    if (typeof reply.maxRequestBodyBytes !== 'number') return null;
    return {
      rawFetch: reply.rawFetch,
      requestBodyStreaming: reply.requestBodyStreaming,
      maxRequestBodyBytes: reply.maxRequestBodyBytes,
    };
  } catch {
    return null;
  }
}

export function localProxyTransport(options: LocalProxyTransportOptions): RealmTransport {
  const endpoint = new URL(PATH, options.url);
  return {
    traits: {
      manualRedirects: true,
      encodedBodies: false,
      maxRequestBody: options.maxRequestBody ?? MAX_REQUEST_BODY,
    },
    async fetch(request: RealmTransportRequest): Promise<RealmTransportResponse> {
      let response: Response;
      try {
        response = await send(options)(endpoint, {
          method: 'POST',
          headers: hopHeaders(options, {
            'X-Slicc-Raw-Request': encodeHead(request.url, request.method, request.headers),
          }),
          ...(request.body ? { body: request.body as BodyInit } : {}),
          signal: request.signal,
          credentials: 'omit',
          mode: 'cors',
        });
      } catch (e) {
        if (request.signal.aborted) throw e;
        throw failure(`${endpoint.origin} is unreachable or refuses this origin`);
      }
      const type = response.headers.get('content-type') ?? '';
      if (response.status !== 200 || !type.startsWith(RAW_CONTENT_TYPE) || !response.body) {
        throw await refusal(response);
      }
      const reader = response.body.getReader();
      let framed: { head: ResponseHead; rest: Uint8Array };
      try {
        framed = await readHead(reader);
      } catch (e) {
        await reader.cancel().catch(() => undefined);
        throw e;
      }
      const body = chunks(framed.rest, reader);
      return {
        status: framed.head.status,
        statusText: framed.head.statusText,
        headers: framed.head.headers,
        body,
        cancel: async () => {
          await body.return(undefined);
          await reader.cancel().catch(() => undefined);
        },
      };
    },
  };
}
