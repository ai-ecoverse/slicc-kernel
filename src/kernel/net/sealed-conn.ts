import { KernelError } from '../fd-table.ts';
import { SCRUB_IDLE_MS } from '../scrub-file.ts';
import type { SealedBroker, SealedCaller } from '../sealed.ts';
import {
  SESSION_EXIT,
  type SessionHead,
  type SessionProtocol,
  type SessionScram,
} from '../sealed-session.ts';
import { HEAD_MAX, sniffHttp1, substituteHead } from './sealed-http1.ts';
import { PG_MESSAGE_MAX, PgClient, PgServer, pgLength, sniffPg } from './sealed-pg.ts';
import type { ScrubScope, SessionScrub } from './sealed-scrubs.ts';
import { SMTP_LINE_MAX, SmtpClient, sniffSmtp } from './sealed-smtp.ts';
import type { UplinkConn } from './uplink.ts';

export const HEAD_IDLE_MS = 2000;

export interface SealedSession {
  broker: SealedBroker;
  stamp: () => Promise<SealedCaller>;
  pid: number;
  host: string;
  port: number;
  exit: string | undefined;
  verified: boolean;
  handshakeAt: number;
  alpn: string | false;
  binding?: Uint8Array | undefined;
}

export function substitutes(s: SealedSession): boolean {
  return (
    s.verified &&
    s.alpn !== 'h2' &&
    s.broker.hook !== undefined &&
    typeof s.exit === 'string' &&
    SESSION_EXIT.test(s.exit)
  );
}

function sessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

async function writeAll(conn: UplinkConn, bytes: Uint8Array): Promise<void> {
  for (let at = 0; at < bytes.length; ) at += await conn.write(bytes.subarray(at));
}

const CRLF2 = [13, 10, 13, 10];

function headEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (CRLF2.every((b, k) => bytes[i + k] === b)) return i + 4;
  }
  return -1;
}

type Mode = 'sniff' | 'http1' | 'smtp' | 'pg' | 'pass';

function modeOf(start: string): Mode | undefined {
  const sniffs: Array<[Mode, 'yes' | 'no' | 'more']> = [
    ['http1', sniffHttp1(start)],
    ['smtp', sniffSmtp(start)],
    ['pg', sniffPg(start)],
  ];
  const hit = sniffs.find(([, v]) => v === 'yes');
  if (hit) return hit[0];
  return sniffs.every(([, v]) => v === 'no') ? 'pass' : undefined;
}

function crlf(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  return -1;
}

class SessionWriter {
  private buffer = new Uint8Array(0);
  private mode: Mode = 'sniff';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private failed: unknown;
  private readonly session = sessionId();
  private readonly smtp: SmtpClient;
  private pgStarted = false;
  sawPg = false;
  private readonly conn: UplinkConn;
  private readonly s: SealedSession;
  private readonly pgClient: PgClient;
  private readonly scope: ScrubScope;
  constructor(conn: UplinkConn, s: SealedSession, pg: PgServer, scope: ScrubScope) {
    this.conn = conn;
    this.s = s;
    this.scope = scope;
    this.pgClient = new PgClient(pg, {
      cleartext: (placeholders) => this.ask('pg', 'password-cleartext', { placeholders }),
      scram: (scram) => this.ask('pg', 'scram-sha-256', { scram }),
    });
    this.smtp = new SmtpClient((position, placeholders) =>
      this.ask('smtp', position, { placeholders })
    );
  }

  write(bytes: Uint8Array): Promise<number> {
    const run = this.chain.then(() => this.take(bytes));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async ask(
    protocol: SessionProtocol,
    position: string,
    extra: { placeholders?: string[]; head?: SessionHead; scram?: SessionScram }
  ): Promise<Record<string, string> | undefined> {
    const s = this.s;
    const values = await s.broker.sessionMaterialize({
      stamp: await s.stamp(),
      session: this.session,
      host: s.host,
      port: s.port,
      protocol,
      position,
      verified: s.verified,
      handshakeAt: s.handshakeAt,
      exit: s.exit as string,
      ...extra,
    });
    return values;
  }

  private remember(values: Record<string, string>): void {
    this.scope.add(
      Object.entries(values).map(([placeholder, value]) => ({ name: 'sealed', value, placeholder }))
    );
  }

  private async take(bytes: Uint8Array): Promise<number> {
    if (this.failed !== undefined) throw this.failed;
    if (this.mode === 'pass') return this.conn.write(bytes);
    clearTimeout(this.timer);
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer);
    joined.set(bytes, this.buffer.length);
    this.buffer.fill(0);
    this.buffer = joined;
    if (this.mode === 'sniff') this.mode = modeOf(latin1(joined.subarray(0, 8))) ?? 'sniff';
    if (this.mode === 'pg') this.sawPg = true;
    if (this.mode === 'pass') await this.release();
    else if (this.mode === 'http1') await this.http1();
    else if (this.mode === 'smtp') await this.lines();
    else if (this.mode === 'pg') await this.messages();
    if (this.mode !== 'pass' && this.buffer.length > 0)
      this.timer = setTimeout(() => this.idle(), HEAD_IDLE_MS);
    return bytes.length;
  }

  private async http1(): Promise<void> {
    const end = headEnd(this.buffer);
    if (end > HEAD_MAX || (end < 0 && this.buffer.length > HEAD_MAX)) await this.release();
    else if (end >= 0) await this.substitute(end);
  }

  private async lines(): Promise<void> {
    for (;;) {
      const at = crlf(this.buffer);
      if (at < 0) break;
      if (at > SMTP_LINE_MAX) return this.release();
      const all = this.buffer;
      this.buffer = all.slice(at + 2);
      const out = await this.smtp
        .line(latin1(all.subarray(0, at)))
        .catch(() => ({ line: latin1(all.subarray(0, at)) }));
      all.fill(0);
      if ('values' in out && out.values) this.remember(out.values);
      const line = bytesOf(`${out.line}\r\n`);
      try {
        await writeAll(this.conn, line);
      } finally {
        line.fill(0);
      }
      if (this.smtp.done) return this.release();
    }
    if (this.buffer.length > SMTP_LINE_MAX) await this.release();
  }

  private async messages(): Promise<void> {
    for (;;) {
      const whole = pgLength(this.buffer, this.pgStarted);
      if (whole === undefined || whole < 4 || whole > PG_MESSAGE_MAX) {
        if (whole !== undefined) await this.release();
        return;
      }
      if (this.buffer.length < whole) return;
      const message = this.buffer.slice(0, whole);
      this.buffer = this.buffer.slice(whole);
      const started = this.pgStarted;
      this.pgStarted = true;
      const out = started
        ? await this.pgClient.message(message).catch(() => ({ bytes: message, done: true }))
        : { bytes: message, done: false };
      if ('values' in out && out.values) this.remember(out.values);
      try {
        await writeAll(this.conn, out.bytes);
      } finally {
        out.bytes.fill(0);
        message.fill(0);
      }
      if (out.done) return this.release();
    }
  }

  private idle(): void {
    this.chain = this.chain
      .then(() => this.release())
      .catch((err: unknown) => {
        this.failed ??= err;
      });
  }

  private async release(): Promise<void> {
    this.mode = 'pass';
    const out = this.buffer;
    this.buffer = new Uint8Array(0);
    try {
      await writeAll(this.conn, out);
    } finally {
      out.fill(0);
    }
  }

  private async substitute(end: number): Promise<void> {
    this.mode = 'pass';
    const all = this.buffer;
    this.buffer = new Uint8Array(0);
    const done = await substituteHead(
      latin1(all.subarray(0, end)),
      (position, placeholders, head) => this.ask('http1', position, { placeholders, head })
    ).catch(() => undefined);
    const head = done ? bytesOf(done.head) : all.subarray(0, end);
    if (done) this.remember(done.values);
    try {
      await writeAll(this.conn, head);
      await writeAll(this.conn, all.subarray(end));
    } finally {
      head.fill(0);
      all.fill(0);
    }
  }

  flushed(): Promise<void> {
    clearTimeout(this.timer);
    this.chain = this.chain.then(() => (this.mode === 'pass' ? undefined : this.release()));
    return this.chain;
  }

  drop(): void {
    clearTimeout(this.timer);
    this.buffer.fill(0);
    this.buffer = new Uint8Array(0);
    this.mode = 'pass';
  }
}

const IDLE = Symbol('idle');

class ScrubReader {
  private stream: ReturnType<SessionScrub['scrubber']['stream']> | undefined;
  private version = 0;
  private next: Promise<Uint8Array | null> | undefined;
  private held = false;
  private ended = false;
  private readonly conn: UplinkConn;
  private readonly scope: ScrubScope;
  constructor(conn: UplinkConn, scope: ScrubScope) {
    this.conn = conn;
    this.scope = scope;
  }

  private current(): Uint8Array {
    const scrub = this.scope.of();
    if (!scrub || scrub.version === this.version) return new Uint8Array(0);
    const tail = this.stream?.end() ?? new Uint8Array(0);
    const stream = scrub.scrubber.stream();
    this.stream = stream;
    this.version = scrub.version;
    this.held = tail.length > 0;
    return tail.length > 0 ? stream.push(tail) : tail;
  }

  async read(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.ended) return null;
      const tail = this.current();
      if (tail.length > 0) return tail;
      const next = this.next ?? this.conn.read();
      this.next = undefined;
      const got = this.held ? await Promise.race([next, idle()]) : await next;
      if (got === IDLE) {
        this.next = next;
        this.held = false;
        const out = (this.stream as NonNullable<typeof this.stream>).idle();
        if (out.length > 0) return out;
        continue;
      }
      const before = this.current();
      const out = this.through(got);
      if (before.length === 0 && out !== undefined) return out;
      if (before.length > 0) return joined(before, out);
    }
  }

  private through(got: Uint8Array | null): Uint8Array | null | undefined {
    const stream = this.stream;
    if (!stream) return got;
    if (got === null) {
      this.ended = true;
      const out = stream.end();
      return out.length > 0 ? out : null;
    }
    const out = stream.push(got);
    this.held = true;
    return out.length > 0 ? out : undefined;
  }
}

function joined(a: Uint8Array, b: Uint8Array | null | undefined): Uint8Array {
  if (!b) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function idle(): Promise<typeof IDLE> {
  return new Promise((resolve) => setTimeout(() => resolve(IDLE), SCRUB_IDLE_MS));
}

export function sealedConn(conn: UplinkConn, s: SealedSession): UplinkConn {
  const pg = new PgServer(s.binding);
  const scope = s.broker.sessions.scope(s.pid, s.host);
  const writer = substitutes(s) ? new SessionWriter(conn, s, pg, scope) : undefined;
  const observed: UplinkConn = {
    ...conn,
    read: async () => {
      for (;;) {
        const bytes = await conn.read();
        if (!bytes) return bytes;
        const out = writer?.sawPg ? pg.filter(bytes) : bytes;
        if (pg.failed) {
          conn.close();
          throw new KernelError(
            'EPROTO',
            'ERR_SSL_PROTOCOL_ERROR: the pg server failed the SCRAM proof'
          );
        }
        if (out.length > 0) return out;
      }
    },
  };
  const reader = new ScrubReader(writer ? observed : conn, scope);
  return {
    localAddr: conn.localAddr,
    remoteAddr: conn.remoteAddr,
    read: () => reader.read(),
    write: (bytes) => (writer ? writer.write(bytes) : conn.write(bytes)),
    closeWrite() {
      if (!writer) return conn.closeWrite();
      void writer.flushed().then(
        () => conn.closeWrite(),
        () => conn.closeWrite()
      );
    },
    close() {
      writer?.drop();
      conn.close();
    },
  };
}
