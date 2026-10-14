import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RealmTransport } from '../kernel/net/transport.ts';

export type HostLoopback = boolean | readonly number[];

export const DEVTOOLS_PORTS: readonly number[] = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];

export type Resolve = (host: string) => Promise<string[]>;

type Place = 'loopback' | 'link-local';

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
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain)?.[1];
  if (mapped) return ipv4Place(mapped);
  if (plain === '::1' || plain === '::') return 'loopback';
  if (/^fe[89ab]/.test(plain)) return 'link-local';
  return undefined;
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
      await checkDestination(request.url, policy, resolve);
      return transport.fetch(request, owner);
    },
    ...(open
      ? {
          websocket: async (request) => {
            await checkDestination(request.url, policy, resolve);
            return open(request);
          },
        }
      : {}),
  };
}
