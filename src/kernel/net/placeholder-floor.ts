import type { SealedCaller } from '../sealed.ts';
import type {
  HeaderList,
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
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

  constructor(reason = PLACEHOLDER_REFUSED) {
    super(reason);
  }
}

export type PlaceholderFill = (
  request: RealmTransportRequest,
  stamp: SealedCaller
) => Promise<RealmTransportResponse>;

export interface PlaceholderFloorOptions {
  known?: () => readonly string[];
  fill?: PlaceholderFill;
}

type Known = readonly string[];

function holds(text: string, known: Known): boolean {
  return PLACEHOLDER.test(text) || known.some((placeholder) => text.includes(placeholder));
}

function carries(text: string, known: Known): boolean {
  let layer = text;
  for (let i = 0; i < PERCENT_LAYERS; i++) {
    if (holds(layer, known)) return true;
    const next = layer.replace(ESCAPE, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (next === layer) return false;
    layer = next;
  }
  return holds(layer, known);
}

function basicCarries(value: string, known: Known): boolean {
  const credential = BASIC.exec(value)?.[1];
  if (credential === undefined) return false;
  const letters = credential
    .replace(/[^A-Za-z0-9+/_-]/g, '')
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  for (let shift = 0; shift < BASE64_GROUP; shift++) {
    const part = letters.slice(shift);
    const whole = part.length % BASE64_GROUP === 1 ? part.slice(0, -1) : part;
    if (carries(atob(whole), known)) return true;
  }
  return false;
}

function headersCarry(headers: HeaderList, known: Known): boolean {
  return headers.some(
    ([name, value]) =>
      carries(name, known) ||
      carries(name.toLowerCase(), known) ||
      carries(value, known) ||
      basicCarries(value, known)
  );
}

function urlCarries(url: string, known: Known): boolean {
  return carries(url, known) || (URL.canParse(url) && carries(new URL(url).href, known));
}

function detected(request: Pick<RealmTransportRequest, 'url' | 'headers'>, known: Known): boolean {
  return urlCarries(request.url, known) || headersCarry(request.headers, known);
}

function refuseSocket(request: RealmWebSocketRequest, known: Known): void {
  if (detected(request, known) || request.protocols.some((p) => carries(p, known))) {
    throw new PlaceholderRefused();
  }
}

export function placeholderFloor(
  inner: RealmTransport,
  { known = () => [], fill }: PlaceholderFloorOptions = {}
): RealmTransport {
  const open = inner.websocket?.bind(inner);
  return {
    get traits() {
      return inner.traits;
    },
    ...(open
      ? {
          websocket: async (request) => {
            refuseSocket(request, known());
            return open(request);
          },
        }
      : {}),
    async fetch(request, owner, stamp) {
      if (!detected(request, known())) return inner.fetch(request, owner, stamp);
      if (!fill || !stamp) throw new PlaceholderRefused();
      return fill(request, stamp);
    },
  };
}
