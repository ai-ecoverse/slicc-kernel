import { KernelError } from '../fd-table.ts';
import { ipv4Bytes, ipv6Groups } from './routes.ts';
import { type ChainShape, chainError, chainShape, nameMatches } from './tls-chain.ts';
import { cipherOf, type TlsCipher } from './tls-ciphers.ts';
import {
  TLS_CLIENT_INSECURE_SKIP_VERIFY,
  TLS_CLIENT_NO_SNI,
  TLS_CLIENT_VERIFY_CHAIN_ONLY,
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
  cipher?: TlsCipher;
  clientCertificate?: boolean;
  sni?: boolean;
  hostnameChecked?: boolean;
  hostnameMatches?: boolean;
  chainError?: string;
  verified: boolean;
  handshakeAt: number;
  substitutes?: boolean;
}

export interface TlsClientOptions {
  engine: TlsEngine;
  store: TlsStore | undefined;
  servername: string;
  alpn: readonly string[];
  insecure: boolean;
  sni?: boolean;
  checkHostname?: boolean;
  session?: TlsSession;
  clientCertificate?: boolean;
  bundled?: boolean;
}

function isIP(name: string): boolean {
  return ipv4Bytes(name) !== undefined || (name.includes(':') && ipv6Groups(name) !== undefined);
}

export function clientFlags(o: TlsClientOptions): number {
  return (
    (o.insecure ? TLS_CLIENT_INSECURE_SKIP_VERIFY : 0) |
    (o.sni === false ? TLS_CLIENT_NO_SNI : 0) |
    (o.checkHostname === false ? TLS_CLIENT_VERIFY_CHAIN_ONLY : 0)
  );
}

export function openSession(o: TlsClientOptions): TlsSession {
  return o.engine.clientSession(o.store, o.servername, o.alpn, clientFlags(o));
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
  return new KernelError('EPROTO', `ERR_SSL_HANDSHAKE_FAILURE: ${text}${alertOf(session)}`);
}

function alertOf(session: TlsSession): string {
  const alert = session.lastAlert;
  return alert >= 0 ? ` (alert ${alert})` : '';
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

function insecureOf(session: TlsSession, chain: readonly Uint8Array[], shape: ChainShape) {
  const flags = session.verifyResult;
  const error = chainError(flags, chain, shape);
  return { hostnameMatches: nameMatches(flags), ...(error ? { chainError: error } : {}) };
}

function controlsOf(
  o: TlsClientOptions,
  session: TlsSession,
  protocol: TlsCipher['version'],
  chain: readonly Uint8Array[],
  shape: ChainShape
) {
  if (!o.engine.sessionControls) return {};
  const checked = o.checkHostname !== false && !o.insecure;
  return {
    cipher: cipherOf(session.ciphersuite, protocol),
    clientCertificate: o.clientCertificate === true,
    sni: o.sni !== false && !isIP(o.servername),
    hostnameChecked: checked,
    ...(o.insecure
      ? insecureOf(session, chain, shape)
      : { hostnameMatches: checked || !session.nameMismatch }),
  };
}

export function verdictOf(o: TlsClientOptions, session: TlsSession): boolean {
  if (o.bundled !== true || isIP(o.servername) || session.verifyResult !== 0) return false;
  return o.checkHostname !== false || !session.nameMismatch;
}

async function infoOf(o: TlsClientOptions, session: TlsSession): Promise<TlsClientInfo> {
  const flags = session.verifyResult;
  const code = verifyCode(flags);
  const protocol = session.version === 0x0304 ? 'TLSv1.3' : 'TLSv1.2';
  const chain = session.peerChain();
  const shape = await chainShape(o.insecure ? chain : []);
  return {
    protocol,
    alpnProtocol: session.alpn ?? false,
    authorized: code === undefined,
    ...(code
      ? { authorizationError: code, authorizationText: o.engine.verifyInfo(flags).trim() }
      : {}),
    peerCertificates: chain,
    ...controlsOf(o, session, protocol, chain, shape),
    verified: verdictOf(o, session),
    handshakeAt: Date.now(),
  };
}

const FATAL_ALERT = -0x7780;

function alerted(err: TlsError, session: TlsSession): KernelError {
  if (err.code === FATAL_ALERT)
    return new KernelError(
      'EPROTO',
      `ERR_SSL_FATAL_ALERT: the server ended the session: ${err.message}${alertOf(session)}`
    );
  return new KernelError('EPROTO', `ERR_SSL_PROTOCOL_ERROR: ${err.message}`);
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
        let got: ReturnType<TlsSession['read']>;
        try {
          got = session.read();
        } catch (err) {
          throw alerted(err as TlsError, session);
        }
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
  const session = o.session ?? openSession(o);
  const inbox = new Ciphertext(conn, session);
  inbox.hand(taken);
  try {
    await handshake(conn, o, session, inbox);
    const info = await infoOf(o, session);
    return { conn: plaintext(conn, session, inbox), info };
  } catch (err) {
    session.free();
    throw err;
  }
}

export interface TlsServerInfo {
  protocol: 'TLSv1.2' | 'TLSv1.3';
  alpnProtocol: string | false;
  servername: string;
  authorized: boolean;
  authorizationError?: string;
  peerCertificates: Uint8Array[];
}

const HTTP_REQUEST = /^[A-Z]{3,10} [!-~]/;

function serverRefusal(err: unknown, session: TlsSession, first: Uint8Array | undefined) {
  const opening = first ? new TextDecoder('latin1').decode(first.subarray(0, 16)) : '';
  if (HTTP_REQUEST.test(opening))
    return new KernelError('EPROTO', 'ERR_SSL_HTTP_REQUEST: http request');
  const text = err instanceof TlsError ? err.message : String(err);
  return new KernelError('EPROTO', `ERR_SSL_HANDSHAKE_FAILURE: ${text}${alertOf(session)}`);
}

async function serverHandshake(
  conn: UplinkConn,
  session: TlsSession,
  inbox: Ciphertext,
  first: () => Uint8Array | undefined
) {
  for (;;) {
    let done: boolean;
    try {
      done = session.handshake();
    } catch (err) {
      await send(conn, session).catch(() => undefined);
      throw serverRefusal(err, session, first());
    }
    await send(conn, session);
    if (done) return;
    if (!(await inbox.more())) {
      throw new KernelError(
        'ECONNRESET',
        'the client closed the connection during the TLS handshake'
      );
    }
  }
}

export async function tlsServer(
  conn: UplinkConn,
  session: TlsSession,
  clientCerts: boolean
): Promise<{ conn: UplinkConn; info: TlsServerInfo }> {
  let first: Uint8Array | undefined;
  const watched: UplinkConn = {
    ...conn,
    read: async () => {
      const bytes = await conn.read();
      first ??= bytes ?? undefined;
      return bytes;
    },
  };
  const inbox = new Ciphertext(watched, session);
  try {
    await serverHandshake(conn, session, inbox, () => first);
    const chain = session.peerChain();
    const code = clientCerts ? verifyCode(session.verifyResult) : undefined;
    const info: TlsServerInfo = {
      protocol: session.version === 0x0304 ? 'TLSv1.3' : 'TLSv1.2',
      alpnProtocol: session.alpn ?? false,
      servername: session.sni,
      authorized: clientCerts && chain.length > 0 && code === undefined,
      ...(clientCerts && chain.length > 0 && code ? { authorizationError: code } : {}),
      peerCertificates: chain,
    };
    return { conn: plaintext(conn, session, inbox), info };
  } catch (err) {
    session.free();
    throw err;
  }
}
