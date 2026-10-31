import type { SealedCaller } from '../sealed.ts';
import { unfollowed } from './remote-transport.ts';
import type {
  HeaderList,
  RealmRedirectHop,
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
} from './transport.ts';

export const HELD_MS = 30_000;
export const HELD_MAX = 64;
export const HELD_PER_OWNER = 8;
const MATCHED = ['range', 'if-none-match', 'if-modified-since', 'if-range', 'accept-encoding'];
const KERNEL = -1;

interface Chain {
  owner: number;
  method: string;
  fingerprint: string;
  hops: readonly RealmRedirectHop[];
  final: RealmTransportResponse;
}

interface Held extends Chain {
  timer: ReturnType<typeof setTimeout>;
}

function header(headers: HeaderList, name: string): string | undefined {
  const values = headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
  return values.length > 0 ? values.join(', ') : undefined;
}

function fingerprint(headers: HeaderList): string {
  const fields = MATCHED.map((name) => header(headers, name) ?? '');
  return JSON.stringify([...fields, header(headers, 'authorization') !== undefined]);
}

function unauthorized(print: string): string {
  return JSON.stringify([...(JSON.parse(print) as unknown[]).slice(0, -1), false]);
}

function followedWith(status: number, method: string): string {
  if (status === 303 && method !== 'GET' && method !== 'HEAD') return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
}

function bodiless(hop: RealmRedirectHop): RealmTransportResponse {
  return {
    url: hop.url,
    status: hop.status,
    statusText: '',
    headers: hop.headers,
    body: (async function* () {})(),
    cancel: async () => undefined,
  };
}

export function replayingHops(inner: RealmTransport, heldMs = HELD_MS): RealmTransport {
  if (!inner.traits.redirectHops || inner.traits.manualRedirects) return inner;
  const held = new Map<string, Held>();

  const drop = (key: string): void => {
    const entry = held.get(key);
    if (!entry) return;
    held.delete(key);
    clearTimeout(entry.timer);
    void entry.final.cancel().catch(() => undefined);
  };
  const keyOf = (owner: number, method: string, url: string) => `${owner} ${method} ${url}`;
  const hold = (key: string, chain: Chain): void => {
    drop(key);
    const mine = [...held.keys()].filter((k) => held.get(k)?.owner === chain.owner);
    if (mine.length >= HELD_PER_OWNER) drop(mine[0] as string);
    if (held.size >= HELD_MAX) drop(held.keys().next().value as string);
    const timer = setTimeout(() => drop(key), heldMs);
    (timer as { unref?: () => void }).unref?.();
    held.set(key, { ...chain, timer });
  };
  const replay = (chain: Chain): RealmTransportResponse => {
    const [hop, ...rest] = chain.hops;
    const location = hop && header(hop.headers, 'location');
    if (!hop || location === undefined) return chain.final;
    const target = new URL(location, hop.url);
    target.hash = '';
    const method = followedWith(hop.status, chain.method);
    const away = target.origin !== new URL(hop.url).origin;
    const print = away ? unauthorized(chain.fingerprint) : chain.fingerprint;
    hold(keyOf(chain.owner, method, target.href), {
      ...chain,
      method,
      fingerprint: print,
      hops: rest,
    });
    return bodiless(hop);
  };

  return {
    get traits() {
      return { ...inner.traits, manualRedirects: true };
    },
    ...(inner.websocket ? { websocket: inner.websocket.bind(inner) } : {}),
    async fetch(
      request: RealmTransportRequest,
      ...rest: [caller?: number, stamp?: SealedCaller]
    ): Promise<RealmTransportResponse> {
      if (unfollowed(request.redirect)) return inner.fetch(request, ...rest);
      const [caller] = rest;
      const owner = caller ?? KERNEL;
      const key = keyOf(owner, request.method, request.url);
      const waiting = held.get(key);
      if (waiting && waiting.fingerprint === fingerprint(request.headers)) {
        held.delete(key);
        clearTimeout(waiting.timer);
        return replay(waiting);
      }
      if (waiting) drop(key);
      const response = await inner.fetch(request, ...rest);
      if (!response.redirects?.length) return response;
      return replay({
        owner,
        method: request.method,
        fingerprint: fingerprint(request.headers),
        hops: response.redirects,
        final: response,
      });
    },
  };
}
