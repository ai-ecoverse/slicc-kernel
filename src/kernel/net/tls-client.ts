import { KernelError } from '../fd-table.ts';
import {
  TLS_CLIENT_INSECURE_SKIP_VERIFY,
  type TlsEngine,
  TlsError,
  type TlsSession,
  type TlsStore,
} from './tls-engine.ts';
import type { UplinkConn } from './uplink.ts';

const WRITE_CHUNK = 16 * 1024;

const BADCERT: ReadonlyArray<[number, string]> = [
  [0x08, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],
  [0x01, 'CERT_HAS_EXPIRED'],
  [0x200, 'CERT_NOT_YET_VALID'],
  [0x02, 'CERT_REVOKED'],
  [0x04, 'ERR_TLS_CERT_ALTNAME_INVALID'],
  [0x800, 'INVALID_PURPOSE'],
  [0x1000, 'INVALID_PURPOSE'],
];

export function verifyCode(flags: number): string | undefined {
  if (flags === 0) return undefined;
  if (flags === -1) return 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  return BADCERT.find(([bit]) => (flags & bit) !== 0)?.[1] ?? 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
}

export interface TlsClientInfo {
  protocol: 'TLSv1.2' | 'TLSv1.3';
  alpnProtocol: string | false;
  authorized: boolean;
  authorizationError?: string;
  authorizationText?: string;
  peerCertificates: Uint8Array[];
}

export interface TlsClientOptions {
  engine: TlsEngine;
  store: TlsStore | undefined;
  servername: string;
  alpn: readonly string[];
  insecure: boolean;
}

class Ciphertext {
  private readonly queue: Uint8Array[] = [];
  private ended = false;
  private readonly conn: UplinkConn;
  private readonly session: TlsSession;
  constructor(conn: UplinkConn, session: TlsSession) {
    this.conn = conn;
    this.session = session;
  }
  hand(bytes: Uint8Array): void {
    if (bytes.length > 0) this.queue.push(bytes);
  }
  async more(): Promise<boolean> {
    if (this.queue.length === 0 && !this.ended) {
      const bytes = await this.conn.read();
      if (bytes) this.queue.push(bytes);
      else this.ended = true;
    }
    if (this.queue.length === 0) {
      this.session.feedEnd();
      return false;
    }
    while (this.queue.length > 0) {
      const head = this.queue[0] as Uint8Array;
      const n = this.session.feed(head);
      if (n < head.length) {
        this.queue[0] = head.subarray(n);
        break;
      }
      this.queue.shift();
    }
    return true;
  }
}

async function send(conn: UplinkConn, session: TlsSession): Promise<void> {
  for (;;) {
    const out = session.take();
    if (out.length === 0) return;
    for (let at = 0; at < out.length; ) {
      const n = await conn.write(out.subarray(at));
      if (!(n > 0)) throw new KernelError('EPIPE');
      at += n;
    }
  }
}

function refused(engine: TlsEngine, session: TlsSession, err: unknown): KernelError {
  const flags = session.verifyResult;
  const code = verifyCode(flags);
  if (code && flags !== -1)
    return new KernelError('EPROTO', `${code}: ${engine.verifyInfo(flags).trim()}`);
  const text = err instanceof TlsError ? err.message : String(err);
  return new KernelError('EPROTO', `ERR_SSL_HANDSHAKE_FAILURE: ${text}`);
}

async function handshake(
  conn: UplinkConn,
  o: TlsClientOptions,
  session: TlsSession,
  inbox: Ciphertext
) {
  for (;;) {
    let done: boolean;
    try {
      done = session.handshake();
    } catch (err) {
      await send(conn, session).catch(() => undefined);
      throw refused(o.engine, session, err);
    }
    await send(conn, session);
    if (done) return;
    if (!(await inbox.more())) {
      throw new KernelError(
        'ECONNRESET',
        'the server closed the connection during the TLS handshake'
      );
    }
  }
}

function infoOf(o: TlsClientOptions, session: TlsSession): TlsClientInfo {
  const flags = session.verifyResult;
  const code = verifyCode(flags);
  return {
    protocol: session.version === 0x0304 ? 'TLSv1.3' : 'TLSv1.2',
    alpnProtocol: session.alpn ?? false,
    authorized: code === undefined,
    ...(code
      ? { authorizationError: code, authorizationText: o.engine.verifyInfo(flags).trim() }
      : {}),
    peerCertificates: session.peerChain(),
  };
}

function plaintext(conn: UplinkConn, session: TlsSession, inbox: Ciphertext): UplinkConn {
  let freed = false;
  let writeClosed = false;
  const free = () => {
    if (freed) return;
    freed = true;
    session.free();
  };
  return {
    localAddr: conn.localAddr,
    remoteAddr: conn.remoteAddr,
    async read() {
      for (;;) {
        if (freed) return null;
        const got = session.read();
        await send(conn, session);
        if (got instanceof Uint8Array) return got;
        if (got === 'eof') return null;
        await inbox.more();
      }
    },
    async write(bytes) {
      if (freed) throw new KernelError('EPIPE');
      for (;;) {
        const n = session.write(bytes.subarray(0, WRITE_CHUNK));
        await send(conn, session);
        if (n > 0) return n;
      }
    },
    closeWrite() {
      if (writeClosed || freed) return;
      writeClosed = true;
      session.close();
      void send(conn, session)
        .catch(() => undefined)
        .finally(() => conn.closeWrite());
    },
    close() {
      free();
      conn.close();
    },
  };
}

export async function tlsClient(
  conn: UplinkConn,
  o: TlsClientOptions,
  taken: Uint8Array = new Uint8Array(0)
): Promise<{ conn: UplinkConn; info: TlsClientInfo }> {
  const flags = o.insecure ? TLS_CLIENT_INSECURE_SKIP_VERIFY : 0;
  const session = o.engine.clientSession(o.store, o.servername, o.alpn, flags);
  const inbox = new Ciphertext(conn, session);
  inbox.hand(taken);
  try {
    await handshake(conn, o, session, inbox);
    return { conn: plaintext(conn, session, inbox), info: infoOf(o, session) };
  } catch (err) {
    session.free();
    throw err;
  }
}
