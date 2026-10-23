import { KernelError } from '../fd-table.ts';
import type { SealedBroker, SealedCaller } from '../sealed.ts';
import { boundHost } from '../sealed-session.ts';
import type { KernelSocket, LoopbackNet } from '../socket.ts';
import { isLoopbackHost } from './proxy-service.ts';
import { ipv4Bytes, ipv6Groups } from './routes.ts';
import { type Anchors, anchorFor } from './sealed-anchor.ts';
import { endPointBinding } from './sealed-binding.ts';
import { type SealedSession, sealedConn, substitutes } from './sealed-conn.ts';
import { openSession, type TlsClientInfo, type TlsClientOptions, tlsClient } from './tls-client.ts';
import { type TlsEngine, TlsError, type TlsSession, type TlsStore } from './tls-engine.ts';
import type { ResolveFamily, UplinkConn } from './uplink.ts';

export interface TlsClientSupport {
  engine: () => Promise<TlsEngine>;
  roots: () => Promise<Uint8Array>;
}

export interface SecureRequest {
  servername?: string;
  alpn?: string[];
  ca?: true | string[];
  insecure?: boolean;
  sni?: false;
  checkHostname?: false;
  clientCert?: ClientCertRequest;
}

export interface ClientCertRequest {
  chain: string[];
  key: string;
  passphrase?: string;
}

export interface SecureProcess {
  net: LoopbackNet;
  sealed?: SealedBroker | undefined;
  stamp?(): Promise<SealedCaller>;
  cred?(): { pid: number };
  blocking(): AbortSignal;
  cancelled?: AbortSignal;
  resolve(name: string, family: ResolveFamily, blocking: () => AbortSignal): Promise<string[]>;
}

export const handshakeAbort = (proc: SecureProcess): AbortSignal =>
  proc.cancelled ?? proc.blocking();

const isIP = (text: string): boolean =>
  ipv4Bytes(text) !== undefined || (text.includes(':') && ipv6Groups(text) !== undefined);

const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

export function serverName(name: string): string {
  if (isIP(name.replace(/^\[|\]$/g, ''))) return name.replace(/^\[|\]$/g, '');
  const bare = name.endsWith('.') ? name.slice(0, -1) : name;
  if (bare.length === 0 || bare.length > 253 || !bare.split('.').every((l) => LABEL.test(l))) {
    throw new KernelError(
      'EINVAL',
      `ERR_INVALID_ARG_VALUE: not a host name: ${JSON.stringify(name)}`
    );
  }
  return name;
}

const defaults = new WeakMap<TlsEngine, Promise<TlsStore>>();

function defaultStore(engine: TlsEngine, roots: () => Promise<Uint8Array>): Promise<TlsStore> {
  let store = defaults.get(engine);
  if (!store) {
    const made = roots().then((bundle) => {
      const s = engine.store();
      s.addBundle(bundle);
      return s;
    });
    store = made;
    defaults.set(engine, made);
    made.catch(() => {
      if (defaults.get(engine) === made) defaults.delete(engine);
    });
  }
  return store;
}

export function base64Der(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface SecureSession {
  path: 'kernel';
  substitutes: boolean;
  verified: boolean;
  verifiedBy: 'bundled' | 'none';
  protocol: TlsClientInfo['protocol'];
  alpnProtocol: string | false;
  authorized: boolean;
  authorizationError?: string;
  authorizationText?: string;
  servername: string;
  peerCertificates: string[];
  cipher?: TlsClientInfo['cipher'];
  clientCertificate?: boolean;
  sni?: boolean;
  hostnameChecked?: boolean;
  hostnameMatches?: boolean;
  chainError?: string;
}

function sessionOf(info: TlsClientInfo, servername: string): SecureSession {
  return {
    path: 'kernel',
    substitutes: info.substitutes === true,
    verified: info.verified,
    verifiedBy: info.verified ? 'bundled' : 'none',
    protocol: info.protocol,
    alpnProtocol: info.alpnProtocol,
    authorized: info.authorized,
    ...(info.authorizationError
      ? {
          authorizationError: info.authorizationError,
          authorizationText: info.authorizationText as string,
        }
      : {}),
    servername,
    peerCertificates: info.peerCertificates.map(encode),
    ...controls(info),
  };
}

function controls(info: TlsClientInfo) {
  if (!info.cipher) return {};
  return {
    cipher: info.cipher,
    clientCertificate: info.clientCertificate === true,
    sni: info.sni !== false,
    hostnameChecked: info.hostnameChecked === true,
    ...(info.hostnameMatches === undefined ? {} : { hostnameMatches: info.hostnameMatches }),
    ...(info.chainError ? { chainError: info.chainError } : {}),
  };
}

const KEY_ERRORS: ReadonlyArray<[number, string]> = [
  [-3, 'ERR_OSSL_X509_KEY_VALUES_MISMATCH'],
  [-0x3b80, 'ERR_OSSL_BAD_DECRYPT'],
  [-0x3c00, 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED'],
];

const PBE_OIDS = [
  [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05],
  [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x01],
];

function hasBytes(hay: Uint8Array, needle: readonly number[]): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((b, j) => hay[i + j] === b)) return true;
  }
  return false;
}

export function encryptedKey(key: Uint8Array): boolean {
  if (key[0] === 0x30) return PBE_OIDS.some((oid) => hasBytes(key, oid));
  return new TextDecoder().decode(key).includes('ENCRYPTED');
}

const KEY_PARSE_RANGES: ReadonlyArray<[number, number]> = [
  [-0x3fff, -0x3800],
  [-0x14ff, -0x1000],
  [-0x6fff, -0x6000],
  [-0x7f, -0x60],
];

const BEFORE_DECRYPT = new Set([
  -0x3c00, -0x3c80, -0x3f80, -0x3980, -0x1180, -0x1200, -0x1280, -0x1400, -0x6080, -0x6180, -0x6a,
]);

const keyParse = (code: number): boolean =>
  !BEFORE_DECRYPT.has(code) && KEY_PARSE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);

export function keyRefused(err: unknown, locked: boolean): KernelError {
  const raw = err instanceof TlsError ? err.code : 0;
  const code = locked && keyParse(raw) ? -0x3b80 : raw;
  const name = KEY_ERRORS.find(([n]) => n === code)?.[1] ?? 'ERR_OSSL_UNSUPPORTED';
  const text =
    code === -3
      ? 'the key does not match the certificate'
      : code === raw
        ? (err as Error).message
        : 'bad decrypt';
  return new KernelError('EPROTO', `${name}: ${text}`);
}

function takeCert(req: SecureRequest) {
  const cert = req.clientCert;
  if (!cert) return undefined;
  delete req.clientCert;
  return certBytes(cert);
}

export function certBytes(cert: ClientCertRequest) {
  if (!Array.isArray(cert.chain) || cert.chain.length === 0 || typeof cert.key !== 'string')
    throw new KernelError('EINVAL', 'ERR_INVALID_ARG_VALUE: cert and key go together');
  let ders: Uint8Array[];
  let key: Uint8Array;
  try {
    ders = cert.chain.map(base64Der);
    key = base64Der(cert.key);
  } catch {
    throw new KernelError('EINVAL', 'ERR_INVALID_ARG_VALUE: cert or key is not base64');
  }
  const chain = new Uint8Array(ders.reduce((n, d) => n + d.length, 0));
  let at = 0;
  for (const der of ders) {
    chain.set(der, at);
    at += der.length;
  }
  const pass = new TextEncoder().encode(cert.passphrase ?? '');
  return { chain, key, pass };
}

export type ClientCert = NonNullable<ReturnType<typeof takeCert>>;

export function withCert(session: TlsSession, cert: ClientCert | undefined): void {
  if (!cert) return;
  try {
    session.ownCert(cert.chain, cert.key, cert.pass);
  } catch (err) {
    throw keyRefused(err, cert.pass.length > 0 && encryptedKey(cert.key));
  }
}

export function wipe(cert: ClientCert | undefined): void {
  cert?.key.fill(0);
  cert?.pass.fill(0);
}

interface Prepared {
  options: TlsClientOptions & { session: TlsSession };
  own: TlsStore | undefined;
}

async function setUp(support: TlsClientSupport, req: SecureRequest) {
  const engine = await support.engine();
  if (!engine.client)
    throw new KernelError('ENOTSUP', 'the installed tls engine has no client sessions');
  const custom = Array.isArray(req.ca) ? req.ca : undefined;
  if (!custom) return { engine, store: await defaultStore(engine, support.roots), own: undefined };
  if (custom.length === 0)
    throw new KernelError('EINVAL', 'ERR_INVALID_ARG_VALUE: ca has no certificate');
  const own = engine.store();
  try {
    for (const der of custom) own.add(base64Der(der));
  } catch (err) {
    own.release();
    throw new KernelError('EINVAL', `ERR_INVALID_ARG_VALUE: ca: ${(err as Error).message}`);
  }
  return { engine, store: own, own };
}

async function prepare(
  support: TlsClientSupport,
  req: SecureRequest,
  servername: string
): Promise<Prepared> {
  const cert = takeCert(req);
  try {
    return await prepareWith(support, req, servername, cert);
  } catch (err) {
    if (err instanceof KernelError) throw err;
    throw new KernelError('ENOTSUP', err instanceof Error ? err.message : String(err));
  } finally {
    wipe(cert);
  }
}

async function prepareWith(
  support: TlsClientSupport,
  req: SecureRequest,
  servername: string,
  cert: ClientCert | undefined
): Promise<Prepared> {
  if (req.checkHostname === false && req.insecure === true) {
    throw new KernelError(
      'EINVAL',
      'ERR_INVALID_ARG_VALUE: checkHostname: false needs rejectUnauthorized'
    );
  }
  const { engine, store, own } = await setUp(support, req);
  const options: TlsClientOptions = {
    engine,
    store,
    servername,
    alpn: req.alpn ?? [],
    insecure: req.insecure === true,
    ...(req.sni === false ? { sni: false } : {}),
    ...(req.checkHostname === false ? { checkHostname: false } : {}),
    clientCertificate: cert !== undefined,
    bundled: own === undefined,
  };
  let session: TlsSession | undefined;
  try {
    const controls = req.sni === false || req.checkHostname === false || cert !== undefined;
    if (controls && !engine.sessionControls) {
      throw new KernelError('ENOTSUP', 'the installed tls engine has no client certificates');
    }
    session = openSession(options);
    withCert(session, cert);
    return { options: { ...options, session }, own };
  } catch (err) {
    session?.free();
    own?.release();
    throw err;
  }
}

export interface Seal {
  proc: SecureProcess;
  port: number;
  engine?: TlsEngine;
}

export function anchoringOf(seal: Seal, info: TlsClientInfo, servername: string) {
  const engine = seal.engine;
  if (!engine?.chainVerify || isIP(servername) || info.peerCertificates.length === 0) return {};
  return {
    anchoring: (found: Anchors) => anchorFor(engine, info.peerCertificates, servername, found),
    anchoredBinding: () => endPointBinding(info.peerCertificates[0]),
  };
}

function sealing(seal: Seal, raw: UplinkConn, info: TlsClientInfo, servername: string) {
  const { proc } = seal;
  const broker = proc.sealed;
  if (!broker || !proc.stamp || !proc.cred) return undefined;
  const stamp = proc.stamp.bind(proc);
  const session: SealedSession = {
    broker,
    stamp,
    pid: proc.cred().pid,
    host: boundHost(servername),
    port: seal.port,
    exit: raw.exit,
    verified: info.verified,
    handshakeAt: info.handshakeAt,
    alpn: info.alpnProtocol,
    ...anchoringOf(seal, info, servername),
  };
  return session;
}

function secure(prepared: Prepared, seal: Seal) {
  let ran = false;
  const make = async (raw: UplinkConn) => {
    ran = true;
    try {
      const made = await tlsClient(raw, prepared.options);
      const engine = prepared.options.engine;
      const session = sealing({ ...seal, engine }, raw, made.info, prepared.options.servername);
      if (!session) return made;
      made.info.substitutes = substitutes(session);
      if (made.info.substitutes && session.verified)
        session.binding = await endPointBinding(made.info.peerCertificates[0]);
      return { conn: sealedConn(made.conn, session), info: made.info };
    } finally {
      prepared.own?.release();
    }
  };
  const abandon = () => {
    if (ran) return;
    prepared.options.session.free();
    prepared.own?.release();
  };
  return { make, abandon };
}

export function supportOf(net: LoopbackNet): TlsClientSupport {
  const support = net.tlsClient;
  if (!support) throw new KernelError('ENOTSUP', 'no tls engine for client sessions');
  return support;
}

export async function uplinkAddress(proc: SecureProcess, host: string): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return bare;
  const [first] = await proc.resolve(host, 0, () => proc.blocking());
  if (!first) throw new KernelError('ENOENT', `ENOTFOUND: ${host}`);
  return first;
}

export async function connectSecure(
  proc: SecureProcess,
  socket: KernelSocket,
  host: string,
  port: number,
  req: SecureRequest
): Promise<SecureSession> {
  const servername = serverName(req.servername || host);
  if (isLoopbackHost(servername) || isLoopbackHost(host)) throw new KernelError('ENOTSUP');
  const address = await uplinkAddress(proc, host);
  const route = proc.net.uplinkFor(address);
  if (!route)
    throw new KernelError('ENOTSUP', 'TLS in the kernel needs a destination the uplink routes');
  const support = supportOf(proc.net);
  let info: TlsClientInfo | undefined;
  const { make, abandon } = secure(await prepare(support, req, servername), { proc, port });
  try {
    await socket.connectSecure({ family: 'inet', host: address, port }, route, async (conn) => {
      info = await conn.upgrade(make);
    });
  } finally {
    abandon();
  }
  return sessionOf(info as TlsClientInfo, servername);
}

async function loopbackSecure(
  proc: SecureProcess,
  socket: KernelSocket,
  servername: string,
  req: SecureRequest
): Promise<SecureSession> {
  const prepared = await prepare(supportOf(proc.net), req, servername);
  let ran = false;
  try {
    const info = await socket.secureLink(async (raw) => {
      ran = true;
      try {
        return await tlsClient(raw, prepared.options);
      } finally {
        prepared.own?.release();
      }
    }, handshakeAbort(proc));
    return sessionOf({ ...info, substitutes: false }, servername);
  } finally {
    if (!ran) {
      prepared.options.session.free();
      prepared.own?.release();
    }
  }
}

export async function upgradeSecure(
  proc: SecureProcess,
  socket: KernelSocket,
  req: SecureRequest
): Promise<SecureSession> {
  const peer = socket.peer;
  if (socket.loopbackLinked) {
    const host = req.servername || (peer?.family === 'inet' ? peer.host : 'localhost');
    return loopbackSecure(proc, socket, serverName(host), req);
  }
  const host = req.servername || (peer?.family === 'inet' ? peer.host : '');
  const servername = serverName(host);
  const port = peer?.family === 'inet' ? peer.port : 0;
  const { make, abandon } = secure(await prepare(supportOf(proc.net), req, servername), {
    proc,
    port,
  });
  try {
    return sessionOf(await socket.upgradeSecure(make), servername);
  } finally {
    abandon();
  }
}
