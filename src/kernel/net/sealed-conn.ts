import { SCRUB_IDLE_MS } from '../scrub-file.ts';
import type { SealedBroker, SealedCaller } from '../sealed.ts';
import { SESSION_EXIT } from '../sealed-session.ts';
import { HEAD_MAX, sniffHttp1, substituteHead } from './sealed-http1.ts';
import type { ScrubScope, SessionScrub } from './sealed-scrubs.ts';
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

class Http1Writer {
  private buffer = new Uint8Array(0);
  private passing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private failed: unknown;
  private readonly conn: UplinkConn;
  private readonly s: SealedSession;
  private readonly scope: ScrubScope;
  constructor(conn: UplinkConn, s: SealedSession, scope: ScrubScope) {
    this.conn = conn;
    this.s = s;
    this.scope = scope;
  }

  write(bytes: Uint8Array): Promise<number> {
    const run = this.chain.then(() => this.take(bytes));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async take(bytes: Uint8Array): Promise<number> {
    if (this.failed !== undefined) throw this.failed;
    if (this.passing) return this.conn.write(bytes);
    clearTimeout(this.timer);
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer);
    joined.set(bytes, this.buffer.length);
    this.buffer.fill(0);
    this.buffer = joined;
    const sniff = sniffHttp1(latin1(joined.subarray(0, 8)));
    const end = sniff === 'yes' ? headEnd(joined) : -1;
    if (sniff === 'no' || end > HEAD_MAX || (end < 0 && joined.length > HEAD_MAX))
      await this.release();
    else if (end >= 0) await this.substitute(end);
    else this.timer = setTimeout(() => this.idle(), HEAD_IDLE_MS);
    return bytes.length;
  }

  private idle(): void {
    this.chain = this.chain
      .then(() => this.release())
      .catch((err: unknown) => {
        this.failed ??= err;
      });
  }

  private async release(): Promise<void> {
    this.passing = true;
    const out = this.buffer;
    this.buffer = new Uint8Array(0);
    try {
      await writeAll(this.conn, out);
    } finally {
      out.fill(0);
    }
  }

  private async substitute(end: number): Promise<void> {
    this.passing = true;
    const all = this.buffer;
    this.buffer = new Uint8Array(0);
    const s = this.s;
    const session = sessionId();
    const done = await substituteHead(
      latin1(all.subarray(0, end)),
      async (position, placeholders, head) =>
        s.broker.sessionMaterialize({
          stamp: await s.stamp(),
          session,
          host: s.host,
          port: s.port,
          protocol: 'http1',
          position,
          verified: s.verified,
          handshakeAt: s.handshakeAt,
          exit: s.exit as string,
          placeholders,
          head,
        })
    ).catch(() => undefined);
    const head = done ? bytesOf(done.head) : all.subarray(0, end);
    if (done) {
      this.scope.add(
        Object.entries(done.values).map(([placeholder, value]) => ({
          name: 'sealed',
          value,
          placeholder,
        }))
      );
    }
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
    this.chain = this.chain.then(() => (this.passing ? undefined : this.release()));
    return this.chain;
  }

  drop(): void {
    clearTimeout(this.timer);
    this.buffer.fill(0);
    this.buffer = new Uint8Array(0);
    this.passing = true;
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
  private readonly s: SealedSession;
  private readonly scope: ScrubScope;
  constructor(conn: UplinkConn, s: SealedSession, scope: ScrubScope) {
    this.conn = conn;
    this.s = s;
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
  const scope = s.broker.sessions.scope(s.pid, s.host);
  const writer = substitutes(s) ? new Http1Writer(conn, s, scope) : undefined;
  const reader = new ScrubReader(conn, s, scope);
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
