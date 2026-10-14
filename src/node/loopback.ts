import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RealmTransport } from '../kernel/net/transport.ts';

export type HostLoopback = boolean | readonly number[];

export const DEVTOOLS_PORTS: readonly number[] = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];

export type Resolve = (host: string) => Promise<string[]>;

type Place = 'loopback' | 'link-local';

const METADATA_V6 = [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254].join(':');

export const resolveHost: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function ipv4Place(address: string): Place | undefined {
  const [a, b] = address.split('.').map(Number) as [number, number];
  if (a === 127 || a === 0) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  return undefined;
}

export function placeOf(address: string): Place | undefined {
  const plain = address.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const kind = isIP(plain);
  if (kind === 4) return ipv4Place(plain);
  if (kind !== 6) return undefined;
  const words = hextets(plain);
  const embedded =
    words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0);
  if (embedded && (words[5] === 0xffff || words[6] !== 0)) return ipv4Place(ipv4Of(words));
  if (words.slice(0, 7).every((w) => w === 0) && (words[7] ?? 0) <= 1) return 'loopback';
  if (((words[0] ?? 0) & 0xffc0) === 0xfe80) return 'link-local';
  if (words.join(':') === METADATA_V6) return 'link-local';
  return undefined;
}

function ipv4Of(words: number[]): string {
  const [high = 0, low = 0] = words.slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function hextets(address: string): number[] {
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  let text = address;
  if (dotted) {
    const [a, b, c, d] = dotted.split('.').map(Number) as [number, number, number, number];
    text = `${address.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const part = (side: string) => (side ? side.split(':').map((w) => Number.parseInt(w, 16)) : []);
  const left = part(head);
  const right = tail === undefined ? [] : part(tail);
  const gap = Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...gap, ...right];
}

function loopbackName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

function allows(policy: HostLoopback, port: number): boolean {
  if (Array.isArray(policy)) return policy.includes(port);
  return policy === true && !DEVTOOLS_PORTS.includes(port);
}

function refusal(url: URL, address: string, place: Place): Error {
  const where = `${address}:${portOf(url)}`;
  const why =
    place === 'link-local'
      ? `nodeTransport refuses link-local ${where}`
      : `nodeTransport refuses the host's loopback ${where} (see nodeTransport({ hostLoopback }))`;
  return Object.assign(new Error(why), { status: 403, code: 'EACCES' });
}

async function addressesOf(host: string, resolve: Resolve): Promise<string[]> {
  const plain = host.replace(/^\[(.*)\]$/, '$1');
  if (isIP(plain)) return [plain];
  if (loopbackName(plain)) return ['127.0.0.1'];
  return resolve(plain).catch(() => []);
}

export async function checkDestination(
  target: string,
  policy: HostLoopback,
  resolve: Resolve = resolveHost
): Promise<void> {
  const url = new URL(target);
  for (const address of await addressesOf(url.hostname, resolve)) {
    const place = placeOf(address);
    if (!place) continue;
    if (place === 'loopback' && allows(policy, portOf(url))) continue;
    throw refusal(url, address, place);
  }
}

function guarded(check: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return check;
  signal.throwIfAborted();
  let stop = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  return Promise.race([check, aborted]).finally(() => signal.removeEventListener('abort', stop));
}

export function guardedLoopback(
  transport: RealmTransport,
  policy: HostLoopback,
  resolve?: Resolve
): RealmTransport {
  const open = transport.websocket?.bind(transport);
  return {
    get traits() {
      return transport.traits;
    },
    fetch: async (request, owner) => {
      await guarded(checkDestination(request.url, policy, resolve), request.signal);
      return transport.fetch(request, owner);
    },
    ...(open
      ? {
          websocket: async (request) => {
            await guarded(checkDestination(request.url, policy, resolve), request.signal);
            return open(request);
          },
        }
      : {}),
  };
}
