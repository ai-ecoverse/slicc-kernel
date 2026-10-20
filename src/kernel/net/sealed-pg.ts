import type { SessionScram } from '../sealed-session.ts';
import { SESSION_PLACEHOLDERS } from '../sealed-session.ts';
import { placeholdersIn, replaced, usable } from './sealed-http1.ts';
import {
  base64Of,
  channelOf,
  clientFirstOf,
  exchangeOf,
  sameBytes,
  saslprep,
  scramKeys,
} from './sealed-scram.ts';

export const PG_MESSAGE_MAX = 16 * 1024;

const PROTOCOL_3 = 0x00030000;
const CLEARTEXT = 3;

function int32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] as number) << 24) |
    ((bytes[at + 1] as number) << 16) |
    ((bytes[at + 2] as number) << 8) |
    (bytes[at + 3] as number)
  );
}

export function sniffPg(start: string): 'yes' | 'no' | 'more' {
  const bytes = Uint8Array.from(start, (c) => c.charCodeAt(0));
  if (bytes.length === 0 || bytes[0] !== 0) return bytes.length === 0 ? 'more' : 'no';
  if (bytes.length < 8) return 'more';
  const length = int32(bytes, 0);
  return length >= 8 && length <= PG_MESSAGE_MAX && int32(bytes, 4) === PROTOCOL_3 ? 'yes' : 'no';
}

const PLAIN = 'SCRAM-SHA-256';
const PLUS = 'SCRAM-SHA-256-PLUS';
const END_POINT = 'p=tls-server-end-point,,';
const SASL = 10;
const SASL_CONTINUE = 11;
const SASL_FINAL = 12;

function latin(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export interface PgExpect {
  real: string;
  fake: string;
}

export class PgServer {
  readonly binding: Uint8Array | undefined;
  plus = false;
  touch: boolean | undefined;
  constructor(binding?: Uint8Array) {
    this.binding = binding;
  }
  private buffer = new Uint8Array(0);
  private skip = 0;
  cleartext = false;
  sasl = false;
  serverFirst: string | undefined;
  expect: PgExpect | undefined;
  failed = false;
  private lost = false;

  private auth(message: Uint8Array): Uint8Array {
    const code = message.length >= 9 ? int32(message, 5) : -1;
    if (this.expect && code !== SASL_FINAL) this.failed = true;
    this.cleartext = message.length === 9 && code === CLEARTEXT;
    if (code === SASL) return this.mechanisms(message);
    else if (code === SASL_CONTINUE) this.serverFirst = latin(message.subarray(9));
    else if (code === SASL_FINAL) this.final(message);
    return message;
  }

  private mechanisms(message: Uint8Array): Uint8Array {
    if (this.touch !== true) return message;
    this.sasl = true;
    const offered = latin(message.subarray(9))
      .split('\0')
      .filter((n) => n !== '');
    this.plus = offered.includes(PLUS);
    const names = offered.filter((n) => n !== PLUS || this.binding !== undefined);
    return frame(0x52, `${latin(message.subarray(5, 9))}${names.map((n) => `${n}\0`).join('')}\0`);
  }

  private final(message: Uint8Array): void {
    const expect = this.expect;
    if (!expect) return;
    this.expect = undefined;
    const data = latin(message.subarray(9));
    if (data !== expect.real || expect.fake.length !== expect.real.length) {
      this.failed = true;
      return;
    }
    for (let i = 0; i < expect.fake.length; i++) message[9 + i] = expect.fake.charCodeAt(i);
  }

  private lose(): void {
    this.lost = true;
    this.cleartext = false;
    this.sasl = false;
    if (this.expect) this.failed = true;
    this.expect = undefined;
  }

  filter(bytes: Uint8Array): Uint8Array {
    if (this.lost) return bytes;
    const data = new Uint8Array(this.buffer.length + bytes.length);
    data.set(this.buffer);
    data.set(bytes, this.buffer.length);
    const out: Uint8Array[] = [];
    let at = 0;
    for (;;) {
      const left = data.length - at;
      if (this.skip > 0) {
        const n = Math.min(this.skip, left);
        out.push(data.subarray(at, at + n));
        this.skip -= n;
        at += n;
        if (this.skip > 0) break;
        continue;
      }
      if (left < 5) break;
      const whole = 1 + int32(data, at + 1);
      if (whole < 5 || (data[at] === 0x52 && whole > PG_MESSAGE_MAX)) {
        this.lose();
        out.push(data.subarray(at));
        at = data.length;
        break;
      }
      if (data[at] !== 0x52) {
        if (this.expect) {
          this.failed = true;
          break;
        }
        this.skip = whole;
        continue;
      }
      if (left < whole) break;
      out.push(this.auth(data.slice(at, at + whole)));
      at += whole;
    }
    this.buffer = data.slice(at);
    const joined = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
    let to = 0;
    for (const b of out) {
      joined.set(b, to);
      to += b.length;
    }
    return joined;
  }
}

export interface PgFrame {
  bytes: Uint8Array;
  values?: Record<string, string>;
  done: boolean;
}

function frame(type: number, body: string): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  const length = 4 + body.length;
  out.set([(length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255], 1);
  for (let i = 0; i < body.length; i++) out[5 + i] = body.charCodeAt(i);
  return out;
}

export function pgLength(bytes: Uint8Array, started: boolean): number | undefined {
  const header = started ? 5 : 4;
  if (bytes.length < header) return undefined;
  const length = int32(bytes, started ? 1 : 0);
  return started ? 1 + length : length;
}

export interface PgAsks {
  cleartext(placeholders: string[]): Promise<Record<string, string> | undefined>;
  scram(scram: SessionScram): Promise<Record<string, string> | undefined>;
}

const MECHANISMS = new Set([PLAIN, PLUS]);

async function cleartext(message: Uint8Array, asks: PgAsks): Promise<PgFrame> {
  const body = latin(message.subarray(5));
  if (!body.endsWith('\0') || body.indexOf('\0') !== body.length - 1)
    return { bytes: message, done: true };
  const password = body.slice(0, -1);
  const placeholders = placeholdersIn(password);
  if (placeholders.length === 0 || placeholders.length > SESSION_PLACEHOLDERS)
    return { bytes: message, done: true };
  const values = usable(await asks.cleartext(placeholders));
  if (Object.keys(values).length === 0) return { bytes: message, done: true };
  return { bytes: frame(0x70, `${replaced(password, values)}\0`), values, done: true };
}

interface Initial {
  mechanism: string;
  data: string;
}

function initial(message: Uint8Array): Initial | undefined {
  const body = latin(message.subarray(5));
  const nul = body.indexOf('\0');
  const mechanism = body.slice(0, nul);
  if (nul < 0 || !MECHANISMS.has(mechanism) || body.length < nul + 5) return undefined;
  const data = message.subarray(5 + nul + 5);
  return int32(message, 5 + nul + 1) === data.length ? { mechanism, data: latin(data) } : undefined;
}

function int32Text(n: number): string {
  return String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

export function serverHeader(header: string, server: PgServer): string {
  if (header === 'n,,') return header;
  if (header === 'y,,' && !server.plus) return header;
  if (header === END_POINT && server.binding) return header;
  return server.plus && server.binding ? END_POINT : 'n,,';
}

function rewritten(first: Initial, header: string): Initial {
  const parsed = clientFirstOf(first.data);
  if (!parsed || parsed.header === header) return first;
  return { mechanism: header === END_POINT ? PLUS : PLAIN, data: `${header}${parsed.bare}` };
}

export class PgClient {
  private clientFirst: string | undefined;
  private header = 'n,,';
  private readonly server: PgServer;
  private readonly asks: PgAsks;
  constructor(server: PgServer, asks: PgAsks) {
    this.server = server;
    this.asks = asks;
  }

  async message(message: Uint8Array): Promise<PgFrame> {
    const server = this.server;
    if (message[0] !== 0x70) return { bytes: message, done: true };
    if (server.cleartext) {
      server.cleartext = false;
      return cleartext(message, this.asks);
    }
    if (server.sasl && this.clientFirst === undefined) {
      const first = initial(message);
      const parsed = first && clientFirstOf(first.data);
      if (!first || !parsed) return { bytes: message, done: true };
      this.clientFirst = first.data;
      this.header = serverHeader(parsed.header, server);
      const sent = rewritten(first, this.header);
      if (sent === first) return { bytes: message, done: false };
      return {
        bytes: frame(0x70, `${sent.mechanism}\0${int32Text(sent.data.length)}${sent.data}`),
        done: false,
      };
    }
    if (this.clientFirst !== undefined && server.serverFirst !== undefined)
      return this.final(message, this.clientFirst, server.serverFirst);
    return { bytes: message, done: true };
  }

  private async final(message: Uint8Array, first: string, serverFirst: string): Promise<PgFrame> {
    const got = exchangeOf(first, serverFirst, latin(message.subarray(5)));
    if (!got) return { bytes: message, done: true };
    const x = got.exchange;
    const binding = this.header === END_POINT ? this.server.binding : undefined;
    const serverFinal = `c=${channelOf(this.header, binding)},r=${got.nonce}`;
    const values = usable(
      await this.asks.scram({
        clientFirstBare: x.clientFirstBare,
        serverFirst: x.serverFirst,
        clientFinalBare: x.clientFinalBare,
        proof: base64Of(got.proof),
      })
    );
    const [entry, ...more] = Object.entries(values);
    const own = { bytes: frame(0x70, `${serverFinal},p=${base64Of(got.proof)}`), done: true };
    if (!entry || more.length > 0)
      return serverFinal === x.clientFinalBare ? { bytes: message, done: true } : own;
    const [placeholder, value] = entry;
    const fake = await scramKeys(placeholder, x);
    if (!sameBytes(fake.proof, got.proof))
      return serverFinal === x.clientFinalBare ? { bytes: message, done: true } : own;
    const real = await scramKeys(saslprep(value), { ...x, clientFinalBare: serverFinal });
    this.server.expect = {
      real: `v=${base64Of(real.serverSignature)}`,
      fake: `v=${base64Of(fake.serverSignature)}`,
    };
    const bytes = frame(0x70, `${serverFinal},p=${base64Of(real.proof)}`);
    for (const k of [real.proof, real.serverSignature, fake.proof, fake.serverSignature]) k.fill(0);
    return { bytes, values, done: true };
  }
}
