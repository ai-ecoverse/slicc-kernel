import type { HttpHead } from '../../kernel/net/http-syscalls.ts';
import type { HeaderList } from '../../kernel/net/transport.ts';
import { JsCallError, type JsKernel } from './js-kernel.ts';

interface FetchTraits {
  manualRedirects: boolean;
  encodedBodies: boolean;
  maxRequestBody: number;
}

interface Hop {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | undefined;
}

const CHUNK = 64 * 1024;
const MAX_REDIRECTS = 20;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set([
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
  'content-length',
]);
const DECODED = new Set(['gzip', 'x-gzip', 'deflate']);
const CREDENTIALS = new Set(['authorization', 'proxy-authorization', 'cookie', 'cookie2']);

function withoutFragment(url: URL): string {
  url.hash = '';
  return url.href;
}

function failed(err: unknown): TypeError {
  return new TypeError('fetch failed', { cause: err });
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function rewrite(hop: Hop, status: number, location: string): Hop {
  const next = new URL(location, hop.url);
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw failed(new JsCallError('EPROTONOSUPPORT', next.protocol));
  }
  const toGet =
    ((status === 301 || status === 302) && hop.method === 'POST') ||
    (status === 303 && hop.method !== 'GET' && hop.method !== 'HEAD');
  const crossOrigin = next.origin !== new URL(hop.url).origin;
  const headers = hop.headers.filter(
    ([name]) =>
      !(toGet && BODY_HEADERS.has(name.toLowerCase())) &&
      !(crossOrigin && CREDENTIALS.has(name.toLowerCase()))
  );
  return {
    url: withoutFragment(next),
    method: toGet ? 'GET' : hop.method,
    headers,
    body: toGet ? undefined : hop.body,
  };
}

const OVER = Symbol('over');
const MIME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[\t ]*;.*)?$/s;
const BASE64 = /;[\t\n\f\r ]*base64$/i;

function isHex(byte: number | undefined): boolean {
  return byte !== undefined && /^[0-9A-Fa-f]$/.test(String.fromCharCode(byte));
}

function percentDecode(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (byte === 0x25 && isHex(bytes[i + 1]) && isHex(bytes[i + 2])) {
      out.push(
        Number.parseInt(String.fromCharCode(bytes[i + 1] as number, bytes[i + 2] as number), 16)
      );
      i += 2;
    } else out.push(byte);
  }
  return Uint8Array.from(out);
}

function dataResponse(request: Request): Response {
  if (request.method !== 'GET') {
    throw failed(new JsCallError('EINVAL', `${request.method} of a data: URL`));
  }
  const url = withoutFragment(new URL(request.url));
  const rest = url.slice('data:'.length);
  const comma = rest.indexOf(',');
  if (comma < 0) throw failed(new JsCallError('EINVAL', 'a data: URL without a comma'));
  let type = rest.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  let body = percentDecode(rest.slice(comma + 1));
  const base64 = BASE64.exec(type);
  if (base64) {
    type = type.slice(0, base64.index).replace(/[\t\n\f\r ]+$/, '');
    let binary: string;
    try {
      binary = atob(String.fromCharCode(...body));
    } catch {
      throw failed(new JsCallError('EINVAL', 'a data: URL whose base64 does not decode'));
    }
    body = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  if (type.startsWith(';')) type = `text/plain${type}`;
  if (!MIME.test(type)) type = 'text/plain;charset=US-ASCII';
  const response = new Response(body as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { 'content-type': type },
  });
  return withMeta(response, url, false);
}

function withMeta(response: Response, url: string, redirected: boolean): Response {
  const clone = response.clone.bind(response);
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response, 'redirected', { value: redirected });
  Object.defineProperty(response, 'clone', { value: () => withMeta(clone(), url, redirected) });
  return response;
}

function bytesOf(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw failed(new TypeError('a request body chunk must be bytes or a string'));
}

async function bodyOf(
  request: Request,
  cap: number,
  signal: AbortSignal
): Promise<Uint8Array | undefined | typeof OVER> {
  signal.throwIfAborted();
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') return undefined;
  const reader = request.body.getReader();
  const stop = (): void => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', stop, { once: true });
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read().catch((err: unknown) => {
        throw signal.aborted ? signal.reason : failed(err);
      });
      signal.throwIfAborted();
      if (next.done) break;
      const chunk = bytesOf(next.value);
      length += chunk.length;
      if (length > cap) {
        reader.cancel().catch(() => undefined);
        return OVER;
      }
      parts.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
  if (length === 0) return undefined;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function fetchOp(kernel: JsKernel) {
  let traits: Promise<FetchTraits> | undefined;
  const traitsOf = (): Promise<FetchTraits> => {
    traits ??= kernel.json({ op: 'net-traits' }) as Promise<FetchTraits>;
    traits.catch(() => {
      traits = undefined;
    });
    return traits;
  };

  const close = (handle: number): Promise<unknown> => kernel.raw({ op: 'net-close', handle });

  const send = async (hop: Hop, signal: AbortSignal): Promise<HttpHead> => {
    signal.throwIfAborted();
    const handle = (await kernel.json({
      op: 'net-open',
      url: hop.url,
      method: hop.method,
      headers: hop.headers,
      ...(hop.body ? { body: hop.body } : {}),
    })) as number;
    try {
      const r = await kernel.blocking({ op: 'net-head', handle }, signal);
      signal.throwIfAborted();
      return (r.ok && r.kind === 'json' ? r.json : undefined) as HttpHead;
    } catch (err) {
      await close(handle);
      throw signal.aborted ? signal.reason : failed(err);
    }
  };

  const body = (handle: number, signal: AbortSignal): ReadableStream<Uint8Array> => {
    let aborted: (() => void) | undefined;
    const settle = (): void => {
      if (aborted) signal.removeEventListener('abort', aborted);
    };
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          aborted = () => {
            controller.error(signal.reason);
            void close(handle);
          };
          signal.addEventListener('abort', aborted, { once: true });
        },
        async pull(controller) {
          let r: Awaited<ReturnType<JsKernel['blocking']>>;
          try {
            signal.throwIfAborted();
            r = await kernel.blocking({ op: 'net-read', handle, max: CHUNK }, signal);
          } catch (err) {
            settle();
            await close(handle);
            throw signal.aborted ? signal.reason : failed(err);
          }
          const bytes = r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
          if (bytes.length > 0) {
            controller.enqueue(bytes);
            return;
          }
          settle();
          controller.close();
          await close(handle);
        },
        cancel: async () => {
          settle();
          await close(handle);
        },
      },
      { highWaterMark: 0 }
    );
  };

  const respond = (
    head: HttpHead,
    method: string,
    redirected: boolean,
    encoded: boolean,
    signal: AbortSignal
  ): Response => {
    if (head.status < 200 || head.status > 599) {
      void close(head.handle);
      throw failed(new JsCallError('EPROTO', `status ${head.status}`));
    }
    const empty = method === 'HEAD' || NULL_BODY.has(head.status);
    if (empty) void close(head.handle);
    const headers = new Headers(head.headers as HeaderList as [string, string][]);
    let stream: ReadableStream<Uint8Array> | null = empty ? null : body(head.handle, signal);
    const coding = headers.get('content-encoding')?.trim().toLowerCase();
    if (stream && encoded && coding && DECODED.has(coding)) {
      const format = coding === 'deflate' ? 'deflate' : 'gzip';
      stream = stream.pipeThrough(
        new DecompressionStream(format) as unknown as TransformStream<Uint8Array, Uint8Array>
      );
      headers.delete('content-encoding');
      headers.delete('content-length');
    }
    const response = new Response(stream, {
      status: head.status,
      statusText: head.statusText,
      headers,
    });
    return withMeta(response, head.url, redirected);
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { signal } = request;
    signal.throwIfAborted();
    const { protocol } = new URL(request.url);
    if (protocol === 'data:') return dataResponse(request);
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw failed(new JsCallError('EPROTONOSUPPORT', protocol));
    }
    const known = await traitsOf().catch((err: unknown) => {
      throw failed(err);
    });
    if (!known.manualRedirects && request.redirect !== 'follow') {
      throw failed(new JsCallError('ENOTSUP', `redirect: ${request.redirect}`));
    }
    const url = withoutFragment(new URL(request.url));
    const bytes = await bodyOf(request, known.maxRequestBody, signal);
    if (bytes === OVER) {
      return withMeta(plain(413, `request body over ${known.maxRequestBody} bytes`), url, false);
    }
    let hop: Hop = {
      url,
      method: request.method,
      headers: [...request.headers],
      body: bytes,
    };
    for (let hops = 0; ; hops++) {
      const head = await send(hop, signal);
      const location = head.headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
      const follow =
        known.manualRedirects &&
        REDIRECTS.has(head.status) &&
        location !== undefined &&
        request.redirect !== 'manual';
      if (!follow) {
        const redirected = hops > 0 || head.redirected === true;
        return respond(head, hop.method, redirected, known.encodedBodies, signal);
      }
      await close(head.handle);
      if (request.redirect === 'error') throw failed(new JsCallError('EREDIRECT', hop.url));
      if (hops >= MAX_REDIRECTS) throw failed(new JsCallError('ELOOP', hop.url));
      hop = rewrite(hop, head.status, location);
    }
  };
}
