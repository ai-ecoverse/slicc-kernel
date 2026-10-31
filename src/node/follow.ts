import type {
  HeaderList,
  RealmTransportRequest,
  RealmTransportResponse,
} from '../kernel/net/transport.ts';

const MAX_REDIRECTS = 20;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set([
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
]);
const CREDENTIALS = new Set(['authorization', 'proxy-authorization', 'cookie', 'cookie2']);

type Send = (request: RealmTransportRequest) => Promise<RealmTransportResponse>;

function failed(message: string): Error {
  return Object.assign(new Error(message), { status: 502, detail: 'transport' });
}

function locationOf(headers: HeaderList): string | undefined {
  return headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
}

function nextHop(
  hop: RealmTransportRequest,
  status: number,
  location: string
): RealmTransportRequest {
  if (!URL.canParse(location, hop.url)) throw failed(`a bad redirect from ${hop.url}`);
  const next = new URL(location, hop.url);
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw failed(`a redirect from ${hop.url} to ${next.protocol}`);
  }
  next.hash = '';
  const toGet =
    ((status === 301 || status === 302) && hop.method === 'POST') ||
    (status === 303 && hop.method !== 'GET' && hop.method !== 'HEAD');
  if (hop.bodyStream && !toGet) throw failed(`a ${status} redirect would resend a streamed body`);
  const crossOrigin = next.origin !== new URL(hop.url).origin;
  const { body, bodyStream, ...rest } = hop;
  return {
    ...rest,
    ...(body && !toGet ? { body } : {}),
    url: next.href,
    method: toGet ? 'GET' : hop.method,
    headers: hop.headers.filter(
      ([name]) =>
        !(toGet && BODY_HEADERS.has(name.toLowerCase())) &&
        !(crossOrigin && CREDENTIALS.has(name.toLowerCase()))
    ),
  };
}

export async function followRedirects(
  send: Send,
  request: RealmTransportRequest
): Promise<RealmTransportResponse> {
  let hop: RealmTransportRequest = { ...request, redirect: 'manual' };
  for (let hops = 0; ; hops++) {
    const response = await send(hop);
    const location = locationOf(response.headers);
    if (!REDIRECTS.has(response.status) || location === undefined) {
      return hops > 0 ? { ...response, url: hop.url, redirected: true } : response;
    }
    await response.cancel();
    if (hops >= MAX_REDIRECTS) throw failed(`too many redirects from ${request.url}`);
    hop = nextHop(hop, response.status, location);
  }
}
