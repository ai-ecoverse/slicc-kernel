import type {
  HeaderList,
  RealmTransport,
  RealmTransportRequest,
  RealmWebSocketRequest,
} from './transport.ts';

const PLACEHOLDER = /fnox_proxy_[0-9a-f]{24}/;
const ESCAPE = /%([0-9a-f]{2})/gi;
const BASIC = /\bbasic\b(.*)/is;
const PERCENT_LAYERS = 8;
const BASE64_GROUP = 4;

export const PLACEHOLDER_REFUSED =
  'refused: this request has a sealed placeholder in its URL, a header or a Basic credential, and nothing fills it, so it was not sent';

export class PlaceholderRefused extends Error {
  readonly status = 403;
  readonly code = 'EACCES';

  constructor() {
    super(PLACEHOLDER_REFUSED);
  }
}

function carries(text: string): boolean {
  let layer = text;
  for (let i = 0; i < PERCENT_LAYERS; i++) {
    if (PLACEHOLDER.test(layer)) return true;
    const next = layer.replace(ESCAPE, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (next === layer) return false;
    layer = next;
  }
  return PLACEHOLDER.test(layer);
}

function basicCarries(value: string): boolean {
  const credential = BASIC.exec(value)?.[1];
  if (credential === undefined) return false;
  const letters = credential
    .replace(/[^A-Za-z0-9+/_-]/g, '')
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  for (let shift = 0; shift < BASE64_GROUP; shift++) {
    const part = letters.slice(shift);
    const whole = part.length % BASE64_GROUP === 1 ? part.slice(0, -1) : part;
    if (carries(atob(whole))) return true;
  }
  return false;
}

function headersCarry(headers: HeaderList): boolean {
  return headers.some(
    ([name, value]) => carries(name.toLowerCase()) || carries(value) || basicCarries(value)
  );
}

function urlCarries(url: string): boolean {
  return carries(url) || (URL.canParse(url) && carries(new URL(url).href));
}

function refuse(request: Pick<RealmTransportRequest, 'url' | 'headers'>): void {
  if (urlCarries(request.url) || headersCarry(request.headers)) throw new PlaceholderRefused();
}

function refuseSocket(request: RealmWebSocketRequest): void {
  refuse(request);
  if (request.protocols.some(carries)) throw new PlaceholderRefused();
}

export function placeholderFloor(inner: RealmTransport): RealmTransport {
  const open = inner.websocket?.bind(inner);
  return {
    get traits() {
      return inner.traits;
    },
    ...(open
      ? {
          websocket: async (request) => {
            refuseSocket(request);
            return open(request);
          },
        }
      : {}),
    async fetch(request, owner) {
      refuse(request);
      return inner.fetch(request, owner);
    },
  };
}
