import { KernelError } from '../fd-table.ts';
import type { KernelSocket } from '../socket.ts';
import { tlsServer } from './tls-client.ts';
import {
  TLS_SERVER_REQUEST_CERT,
  TLS_SERVER_REQUIRE_CERT,
  type TlsEngine,
  type TlsLeaf,
  type TlsStore,
} from './tls-engine.ts';
import {
  base64Der,
  type ClientCert,
  type ClientCertRequest,
  certBytes,
  encode,
  encryptedKey,
  keyRefused,
  type SecureProcess,
  supportOf,
  wipe,
} from './tls-uplink.ts';

export interface ServeRequest {
  cert?: ClientCertRequest;
  ca?: string[];
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  alpn?: string[];
  listener?: KernelSocket;
}

export interface ServedSession {
  path: 'kernel';
  protocol: 'TLSv1.2' | 'TLSv1.3';
  alpnProtocol: string | false;
  servername: string;
  authorized: boolean;
  authorizationError?: string;
  peerCertificates: string[];
}

interface Server {
  engine: TlsEngine;
  leaf: TlsLeaf;
  store: TlsStore | undefined;
  alpn: string[];
  flags: number;
  release(): void;
}

function leafOf(engine: TlsEngine, cert: ClientCert): TlsLeaf {
  try {
    return engine.importLeaf(cert.chain, cert.key, cert.pass);
  } catch (err) {
    throw keyRefused(err, cert.pass.length > 0 && encryptedKey(cert.key));
  } finally {
    wipe(cert);
  }
}

function storeOf(engine: TlsEngine, ca: readonly string[]): TlsStore {
  const store = engine.store();
  try {
    for (const der of ca) store.add(base64Der(der));
    return store;
  } catch (err) {
    store.release();
    throw new KernelError('EINVAL', `ERR_INVALID_ARG_VALUE: ca: ${(err as Error).message}`);
  }
}

function flagsOf(req: ServeRequest, store: TlsStore | undefined): number {
  if (!req.requestCert) return 0;
  if (!store) throw new KernelError('EINVAL', 'ERR_INVALID_ARG_VALUE: requestCert needs a ca');
  return req.rejectUnauthorized === false ? TLS_SERVER_REQUEST_CERT : TLS_SERVER_REQUIRE_CERT;
}

export async function serverOf(proc: SecureProcess, req: ServeRequest): Promise<Server> {
  const own = req.cert;
  delete req.cert;
  if (!own) throw new KernelError('EINVAL', 'ERR_INVALID_ARG_VALUE: a server needs cert and key');
  const cert = certBytes(own);
  let engine: TlsEngine;
  try {
    engine = await supportOf(proc.net).engine();
    if (!engine.serverSessions)
      throw new KernelError('ENOTSUP', 'the installed tls engine has no server sessions');
  } catch (err) {
    wipe(cert);
    throw err;
  }
  const leaf = leafOf(engine, cert);
  let store: TlsStore | undefined;
  try {
    store = req.ca && req.ca.length > 0 ? storeOf(engine, req.ca) : undefined;
    const flags = flagsOf(req, store);
    return {
      engine,
      leaf,
      store,
      alpn: req.alpn ?? [],
      flags,
      release() {
        leaf.release();
        store?.release();
      },
    };
  } catch (err) {
    leaf.release();
    store?.release();
    throw err;
  }
}

export async function listenSecure(
  proc: SecureProcess,
  socket: KernelSocket,
  req: ServeRequest
): Promise<void> {
  if (!socket.listening) throw new KernelError('EINVAL', 'not a listening socket');
  const server = await serverOf(proc, req);
  socket.serving?.release();
  socket.serving = server;
}

export async function serveSecure(
  proc: SecureProcess,
  socket: KernelSocket,
  req: ServeRequest
): Promise<ServedSession> {
  const shared = req.listener?.serving as Server | undefined;
  if (req.listener && !shared) throw new KernelError('EINVAL', 'the listener has no tls');
  const server = shared ?? (await serverOf(proc, req));
  try {
    const { engine, leaf, alpn, store, flags } = server;
    const info = await socket.secureLink((raw) =>
      tlsServer(raw, engine.serverSession(leaf, alpn, store, flags), flags !== 0)
    );
    return {
      path: 'kernel',
      protocol: info.protocol,
      alpnProtocol: info.alpnProtocol,
      servername: info.servername,
      authorized: info.authorized,
      ...(info.authorizationError ? { authorizationError: info.authorizationError } : {}),
      peerCertificates: info.peerCertificates.map(encode),
    };
  } finally {
    if (!shared) server.release();
  }
}
