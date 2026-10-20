import type { InetAddr } from '../dgram.ts';
import type { KernelSocket, LoopbackNet } from '../socket.ts';
import { ipv4Bytes, ipv6Groups } from './routes.ts';
import type { RealmTransport } from './transport.ts';
import type { ResolveFamily } from './uplink.ts';

export const DNS_PORT = 53;
export const DNS_STUB_ADDRESS = '127.0.0.53';
export const RESOLV_CONF_PATH = '/etc/resolv.conf';
export const RESOLV_CONF = `nameserver ${DNS_STUB_ADDRESS}\noptions edns0\n`;
export const DNS_STUB_TTL = 30;
export const DEFAULT_DOH = 'https://cloudflare-dns.com/dns-query';
export const DNS_FORWARD_TIMEOUT_MS = 5000;
export const DNS_TCP_IDLE_MS = 10_000;
export const DNS_TCP_MAX = 64;
export const DNS_UDP_INFLIGHT = 64;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_AAAA = 28;
const TYPE_OPT = 41;
const CLASS_IN = 1;
const NOERROR = 0;
const FORMERR = 1;
const SERVFAIL = 2;
const NXDOMAIN = 3;
const NOTIMP = 4;
const QR = 0x8000;
const AA = 0x0400;
const TC = 0x0200;
const RD = 0x0100;
const RA = 0x0080;
const CD = 0x0010;
const UDP_PLAIN = 512;
const UDP_EDNS = 1232;
const UDP_MAX = 4096;
const DOH_MAX = 65535;
const LOCAL_ZONES = ['localhost', 'slicc.internal'];
const MESSAGE = 'application/dns-message';

export interface StubResolver {
  resolve(name: string, family: ResolveFamily): Promise<string[]>;
  known(name: string): Promise<boolean>;
  reverse(address: string): Promise<string | undefined>;
}

export type DnsForward = (
  query: Uint8Array,
  signal: AbortSignal
) => Promise<Uint8Array | undefined>;

export interface DnsQuestion {
  id: number;
  flags: number;
  name: string;
  type: number;
  klass: number;
  end: number;
  edns: number | undefined;
}

type Parsed =
  | { ok: true; question: DnsQuestion }
  | { ok: false; id: number; flags: number; rcode: number };

const u16 = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];

function skipName(b: Uint8Array, at: number): number | undefined {
  let i = at;
  for (let hops = 0; hops < 128; hops++) {
    if (i >= b.length) return undefined;
    const len = b[i];
    if (len === 0) return i + 1;
    if ((len & 0xc0) === 0xc0) return i + 2 <= b.length ? i + 2 : undefined;
    if (len & 0xc0) return undefined;
    i += len + 1;
  }
  return undefined;
}

function readName(b: Uint8Array, at: number): { name: string; end: number } | undefined {
  const labels: string[] = [];
  let i = at;
  let size = 0;
  for (;;) {
    if (i >= b.length) return undefined;
    const len = b[i];
    if (len === 0) break;
    if (len & 0xc0) return undefined;
    size += len + 1;
    if (size > 254 || i + 1 + len > b.length) return undefined;
    labels.push(new TextDecoder().decode(b.subarray(i + 1, i + 1 + len)));
    i += len + 1;
  }
  return { name: labels.join('.').toLowerCase(), end: i + 1 };
}

export function parseQuery(b: Uint8Array): Parsed | undefined {
  if (b.length < 12) return undefined;
  const id = u16(b, 0);
  const flags = u16(b, 2);
  if (flags & QR) return undefined;
  if ((flags >> 11) & 0xf) return { ok: false, id, flags, rcode: NOTIMP };
  if (u16(b, 4) !== 1) return { ok: false, id, flags, rcode: FORMERR };
  const read = readName(b, 12);
  if (!read || read.end + 4 > b.length) return { ok: false, id, flags, rcode: FORMERR };
  const type = u16(b, read.end);
  const klass = u16(b, read.end + 2);
  const end = read.end + 4;
  let edns: number | undefined;
  let at = end;
  const records = u16(b, 6) + u16(b, 8) + u16(b, 10);
  for (let n = 0; n < records; n++) {
    const after = skipName(b, at);
    if (after === undefined || after + 10 > b.length)
      return { ok: false, id, flags, rcode: FORMERR };
    if (u16(b, after) === TYPE_OPT) edns = Math.max(UDP_PLAIN, u16(b, after + 2));
    at = after + 10 + u16(b, after + 8);
    if (at > b.length) return { ok: false, id, flags, rcode: FORMERR };
  }
  return { ok: true, question: { id, flags, name: read.name, type, klass, end, edns } };
}

function encodeName(name: string): number[] {
  const out: number[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = new TextEncoder().encode(label);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return out;
}

function header(id: number, flags: number, counts: [number, number, number, number]): number[] {
  const out = [id >> 8, id & 0xff, flags >> 8, flags & 0xff];
  for (const c of counts) out.push(c >> 8, c & 0xff);
  return out;
}

function opt(): number[] {
  return [0, 0, TYPE_OPT, UDP_EDNS >> 8, UDP_EDNS & 0xff, 0, 0, 0, 0, 0, 0];
}

function record(type: number, rdata: number[]): number[] {
  const ttl = DNS_STUB_TTL;
  return [
    0xc0,
    0x0c,
    type >> 8,
    type & 0xff,
    0,
    CLASS_IN,
    (ttl >>> 24) & 0xff,
    (ttl >>> 16) & 0xff,
    (ttl >>> 8) & 0xff,
    ttl & 0xff,
    rdata.length >> 8,
    rdata.length & 0xff,
    ...rdata,
  ];
}

function replyFlags(query: number, rcode: number, aa: boolean): number {
  return QR | (query & 0x7800) | (aa ? AA : 0) | (query & RD) | RA | (query & CD) | rcode;
}

export function errorReply(id: number, flags: number, rcode: number): Uint8Array {
  return new Uint8Array(header(id, replyFlags(flags, rcode, false), [0, 0, 0, 0]));
}

export function answerReply(
  query: Uint8Array,
  q: DnsQuestion,
  rcode: number,
  answers: number[][],
  aa: boolean
): Uint8Array {
  const extra = q.edns !== undefined ? [opt()] : [];
  return new Uint8Array([
    ...header(q.id, replyFlags(q.flags, rcode, aa), [1, answers.length, 0, extra.length]),
    ...query.subarray(12, q.end),
    ...answers.flat(),
    ...extra.flat(),
  ]);
}

export function truncated(reply: Uint8Array, q: DnsQuestion, query: Uint8Array): Uint8Array {
  const limit = q.edns !== undefined ? Math.min(q.edns, UDP_MAX) : UDP_PLAIN;
  if (reply.length <= limit) return reply;
  const flags = u16(reply, 2) | TC;
  const extra = q.edns !== undefined ? [opt()] : [];
  return new Uint8Array([
    ...header(q.id, flags, [1, 0, 0, extra.length]),
    ...query.subarray(12, q.end),
    ...extra.flat(),
  ]);
}

function ipv6Text(groups: number[]): string {
  return groups.map((g) => g.toString(16)).join(':');
}

export function reverseAddress(name: string): string | undefined {
  if (name.endsWith('.in-addr.arpa')) {
    const parts = name.slice(0, -'.in-addr.arpa'.length).split('.');
    if (parts.length !== 4) return undefined;
    const text = parts.reverse().join('.');
    return ipv4Bytes(text) ? text.split('.').map(Number).join('.') : undefined;
  }
  if (name.endsWith('.ip6.arpa')) {
    const nibbles = name.slice(0, -'.ip6.arpa'.length).split('.');
    if (nibbles.length !== 32 || !nibbles.every((n) => /^[0-9a-f]$/.test(n))) return undefined;
    const hex = nibbles.reverse().join('');
    const groups = Array.from({ length: 8 }, (_, i) =>
      Number.parseInt(hex.slice(i * 4, i * 4 + 4), 16)
    );
    return ipv6Text(groups);
  }
  return undefined;
}

export function sameAddress(a: string, b: string): boolean {
  const a6 = ipv6Groups(a);
  const b6 = ipv6Groups(b);
  if (a6 && b6) return ipv6Text(a6) === ipv6Text(b6);
  return a === b;
}

function local(name: string): boolean {
  return LOCAL_ZONES.some((zone) => name === zone || name.endsWith(`.${zone}`));
}

function literal(name: string): boolean {
  return ipv4Bytes(name) !== undefined || ipv6Groups(name) !== undefined;
}

function addressData(address: string, type: number): number[] | undefined {
  if (type === TYPE_A) return ipv4Bytes(address);
  const groups = type === TYPE_AAAA ? ipv6Groups(address) : undefined;
  return groups?.flatMap((g) => [g >> 8, g & 0xff]);
}

export interface DnsStubOptions {
  resolver: StubResolver;
  forward?: DnsForward | undefined;
  timeoutMs?: number;
}

export class DnsStub {
  private readonly resolver: StubResolver;
  private readonly forwarder: DnsForward | undefined;
  private readonly timeoutMs: number;

  constructor(options: DnsStubOptions) {
    this.resolver = options.resolver;
    this.forwarder = options.forward;
    this.timeoutMs = options.timeoutMs ?? DNS_FORWARD_TIMEOUT_MS;
  }

  async answer(query: Uint8Array, udp: boolean): Promise<Uint8Array | undefined> {
    const parsed = parseQuery(query);
    if (!parsed) return undefined;
    if (!parsed.ok) return errorReply(parsed.id, parsed.flags, parsed.rcode);
    const q = parsed.question;
    const reply = await this.reply(query, q).catch(() =>
      answerReply(query, q, SERVFAIL, [], false)
    );
    return udp ? truncated(reply, q, query) : reply;
  }

  private async reply(query: Uint8Array, q: DnsQuestion): Promise<Uint8Array> {
    if (q.klass !== CLASS_IN || literal(q.name)) return this.forward(query, q);
    if (q.type === TYPE_PTR) {
      const address = reverseAddress(q.name);
      const name = address !== undefined ? await this.resolver.reverse(address) : undefined;
      if (name !== undefined)
        return answerReply(query, q, NOERROR, [record(TYPE_PTR, encodeName(name))], true);
      return this.forward(query, q);
    }
    if (q.type === TYPE_A || q.type === TYPE_AAAA) {
      const addresses = q.name === '' ? [] : await this.resolver.resolve(q.name, 0);
      const answers = addresses.flatMap((a) => {
        const data = addressData(a, q.type);
        return data ? [record(q.type, data)] : [];
      });
      if (answers.length > 0 || local(q.name) || (await this.resolver.known(q.name))) {
        const rcode = addresses.length > 0 ? NOERROR : NXDOMAIN;
        return answerReply(query, q, rcode, answers, local(q.name));
      }
      return this.forward(query, q);
    }
    if (await this.resolver.known(q.name)) return answerReply(query, q, NOERROR, [], true);
    if (local(q.name)) {
      const there = (await this.resolver.resolve(q.name, 0)).length > 0;
      return answerReply(query, q, there ? NOERROR : NXDOMAIN, [], true);
    }
    return this.forward(query, q);
  }

  private async forward(query: Uint8Array, q: DnsQuestion): Promise<Uint8Array> {
    if (!this.forwarder) return answerReply(query, q, SERVFAIL, [], false);
    const asked = query.slice();
    asked[0] = 0;
    asked[1] = 0;
    const got = await this.forwarder(asked, AbortSignal.timeout(this.timeoutMs)).catch(
      () => undefined
    );
    if (!got || got.length < 12 || !(u16(got, 2) & QR))
      return answerReply(query, q, SERVFAIL, [], false);
    const reply = got.slice();
    reply[0] = q.id >> 8;
    reply[1] = q.id & 0xff;
    return reply;
  }
}

async function collect(
  body: AsyncIterable<Uint8Array>,
  max: number
): Promise<Uint8Array | undefined> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of body) {
    size += part.length;
    if (size > max) return undefined;
    parts.push(part);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function dohForward(transport: RealmTransport, url: string): DnsForward {
  return async (query, signal) => {
    const res = await transport.fetch({
      url,
      method: 'POST',
      headers: [
        ['content-type', MESSAGE],
        ['accept', MESSAGE],
      ],
      body: query,
      signal,
    });
    const type = res.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    if (res.status !== 200 || type.split(';')[0].trim().toLowerCase() !== MESSAGE) {
      await res.cancel().catch(() => undefined);
      return undefined;
    }
    return collect(res.body, DOH_MAX);
  };
}

export function kernelDnsStub(
  resolver: StubResolver,
  transport: RealmTransport,
  doh: string | false | undefined
): DnsStub {
  const url = doh ?? DEFAULT_DOH;
  return new DnsStub({ resolver, forward: url === false ? undefined : dohForward(transport, url) });
}

async function readExactly(
  conn: KernelSocket,
  size: number,
  signal: AbortSignal
): Promise<Uint8Array | undefined> {
  const out = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    const piece = await conn.read(size - at, signal);
    if (piece.length === 0) return undefined;
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

async function serveTcp(stub: DnsStub, conn: KernelSocket): Promise<void> {
  try {
    for (;;) {
      const idle = AbortSignal.timeout(DNS_TCP_IDLE_MS);
      const size = await readExactly(conn, 2, idle);
      if (!size) return;
      const query = await readExactly(conn, u16(size, 0), idle);
      if (!query) return;
      const reply = await stub.answer(query, false);
      if (!reply) return;
      const framed = new Uint8Array([reply.length >> 8, reply.length & 0xff, ...reply]);
      const sent = await conn.write(framed, AbortSignal.timeout(DNS_TCP_IDLE_MS));
      if (sent < framed.length) return;
    }
  } catch {
    return;
  } finally {
    conn.close();
  }
}

export function enableDnsStub(net: LoopbackNet, stub: DnsStub): void {
  const at = { family: 'inet', host: '127.0.0.1', port: DNS_PORT } as const;
  net.activate(at, () => {
    const listener = net.listen(at);
    const open = new Set<KernelSocket>();
    void (async () => {
      for (;;) {
        const conn = await listener.accept().catch(() => undefined);
        if (!conn) return;
        if (open.size >= DNS_TCP_MAX) {
          conn.close();
          continue;
        }
        open.add(conn);
        void serveTcp(stub, conn).finally(() => open.delete(conn));
      }
    })();
  });
  let inflight = 0;
  net.serveDgram(DNS_PORT, (datagram, to) => {
    if (inflight >= DNS_UDP_INFLIGHT) return;
    inflight++;
    void stub
      .answer(datagram.bytes, true)
      .then(
        (reply) => {
          if (!reply) return;
          const from: InetAddr = { family: 'inet', host: to.host, port: DNS_PORT };
          net.deliverDgram(datagram.from.port, { bytes: reply, from });
        },
        () => undefined
      )
      .finally(() => inflight--);
  });
}
