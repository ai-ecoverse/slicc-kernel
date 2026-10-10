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
      !(crossOrigin && name.toLowerCase() === 'authorization')
  );
  return {
    url: next.href,
    method: toGet ? 'GET' : hop.method,
    headers,
    body: toGet ? undefined : hop.body,
  };
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
    const handle = (await kernel.json({
      op: 'net-open',
      url: hop.url,
      method: hop.method,
      headers: hop.headers,
      ...(hop.body ? { body: hop.body } : {}),
    })) as number;
    try {
      const r = await kernel.blocking({ op: 'net-head', handle }, signal);
      return (r.ok && r.kind === 'json' ? r.json : undefined) as HttpHead;
    } catch (err) {
      await close(handle);
      throw signal.aborted ? signal.reason : failed(err);
    }
  };

  const body = (handle: number, signal: AbortSignal): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          let r: Awaited<ReturnType<JsKernel['blocking']>>;
          try {
            r = await kernel.blocking({ op: 'net-read', handle, max: CHUNK }, signal);
          } catch (err) {
            await close(handle);
            throw signal.aborted ? signal.reason : failed(err);
          }
          const bytes = r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
          if (bytes.length > 0) {
            controller.enqueue(bytes);
            return;
          }
          controller.close();
          await close(handle);
        },
        cancel: () => close(handle).then(() => undefined),
      },
      { highWaterMark: 0 }
    );

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
    Object.defineProperty(response, 'url', { value: head.url });
    Object.defineProperty(response, 'redirected', { value: redirected });
    return response;
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { signal } = request;
    signal.throwIfAborted();
    const known = await traitsOf().catch((err: unknown) => {
      throw failed(err);
    });
    const bytes =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    if (bytes && bytes.length > known.maxRequestBody) {
      return plain(413, `request body over ${known.maxRequestBody} bytes`);
    }
    if (!known.manualRedirects && request.redirect !== 'follow') {
      throw failed(new JsCallError('ENOTSUP', `redirect: ${request.redirect}`));
    }
    let hop: Hop = {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: bytes && bytes.length > 0 ? bytes : undefined,
    };
    for (let hops = 0; ; hops++) {
      const head = await send(hop, signal);
      const location = head.headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
      const follow =
        known.manualRedirects &&
        REDIRECTS.has(head.status) &&
        location !== undefined &&
        request.redirect !== 'manual';
      if (!follow) return respond(head, hop.method, hops > 0, known.encodedBodies, signal);
      await close(head.handle);
      if (request.redirect === 'error') throw failed(new JsCallError('EREDIRECT', hop.url));
      if (hops >= MAX_REDIRECTS) throw failed(new JsCallError('ELOOP', hop.url));
      hop = rewrite(hop, head.status, location);
    }
  };
}
