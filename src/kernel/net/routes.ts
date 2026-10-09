import { HOST_LOOPBACK, HOST_LOOPBACK_ADDRESS } from './loopback-names.ts';

export type NetworkLabel = 'none' | 'default' | 'uplink';

export const NETWORK_LABELS: readonly NetworkLabel[] = ['none', 'default', 'uplink'];

export function isNetworkLabel(value: unknown): value is NetworkLabel {
  return typeof value === 'string' && (NETWORK_LABELS as readonly string[]).includes(value);
}

export function narrower(a: NetworkLabel, b: NetworkLabel | undefined): NetworkLabel {
  if (b === undefined) return a;
  return NETWORK_LABELS.indexOf(b) < NETWORK_LABELS.indexOf(a) ? b : a;
}

export function widens(ceiling: NetworkLabel, asked: NetworkLabel): boolean {
  return NETWORK_LABELS.indexOf(asked) > NETWORK_LABELS.indexOf(ceiling);
}

export interface RouteTable {
  prefixes: readonly string[];
  exit: boolean;
}

export type Destination = 'loopback' | 'host' | 'reserved' | 'uplink' | 'unreachable';

interface Prefix {
  v6: boolean;
  bits: bigint;
  length: number;
}

const HOST_ADDRESS = HOST_LOOPBACK_ADDRESS.join('.');

export function ipv4Bytes(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : undefined;
}

export function ipv6Groups(text: string): number[] | undefined {
  if (!text.includes(':')) return undefined;
  let canonical: string;
  try {
    canonical = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const [head, tail] = canonical.split('::');
  const part = (s: string | undefined) =>
    s ? s.split(':').map((h) => Number.parseInt(h, 16)) : [];
  const front = part(head);
  const back = part(tail);
  return tail === undefined
    ? front
    : [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

function toBits(values: number[], width: number): bigint {
  return values.reduce((acc, v) => (acc << BigInt(width)) | BigInt(v), 0n);
}

function addressBits(host: string): { v6: boolean; bits: bigint } | undefined {
  const v4 = ipv4Bytes(host);
  if (v4) return { v6: false, bits: toBits(v4, 8) };
  const v6 = ipv6Groups(host);
  return v6 ? { v6: true, bits: toBits(v6, 16) } : undefined;
}

function parsePrefix(text: string): Prefix | undefined {
  const [address = '', size] = text.trim().split('/');
  const parsed = addressBits(address);
  if (!parsed) return undefined;
  const max = parsed.v6 ? 128 : 32;
  const length = size === undefined ? max : /^\d{1,3}$/.test(size) ? Number(size) : -1;
  if (length < 0 || length > max) return undefined;
  return { ...parsed, length };
}

function within(prefix: Prefix, addr: { v6: boolean; bits: bigint }): boolean {
  if (prefix.v6 !== addr.v6) return false;
  const shift = BigInt((prefix.v6 ? 128 : 32) - prefix.length);
  return addr.bits >> shift === prefix.bits >> shift;
}

const RESERVED = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/96',
  '::ffff:0:0/96',
  'fe80::/10',
  'ff00::/8',
].map((p) => parsePrefix(p) as Prefix);

export class Routes {
  private table: Prefix[] = [];
  private exit = false;
  readonly ipv6: boolean;

  constructor(ipv6 = false) {
    this.ipv6 = ipv6;
  }

  set(table: RouteTable): void {
    const parsed = (table.prefixes ?? []).map(parsePrefix);
    const bad = (table.prefixes ?? []).find((_, i) => !parsed[i]);
    if (bad !== undefined) throw new Error(`not an address prefix: ${bad}`);
    this.table = parsed as Prefix[];
    this.exit = table.exit === true;
  }

  classify(host: string): Destination {
    const name = host.toLowerCase().replace(/\.$/, '');
    if (name === 'localhost' || name.endsWith('.localhost') || name === '0.0.0.0') {
      return 'loopback';
    }
    if (name === HOST_LOOPBACK || name === HOST_ADDRESS) return 'host';
    const addr = addressBits(name);
    if (!addr) return 'unreachable';
    if (addr.v6 && addr.bits === 1n) return 'loopback';
    if (!addr.v6 && addr.bits >> 24n === 127n) return 'loopback';
    if (RESERVED.some((p) => within(p, addr))) return 'reserved';
    if (addr.v6 && !this.ipv6) return 'unreachable';
    if (this.exit || this.table.some((p) => within(p, addr))) return 'uplink';
    return 'unreachable';
  }
}
