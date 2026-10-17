import { KernelError } from '../fd-table.ts';
import type { KernelSocket, LoopbackNet } from '../socket.ts';
import { isLoopbackHost } from './proxy-service.ts';
import { ipv4Bytes, ipv6Groups } from './routes.ts';
import { type TlsClientInfo, tlsClient } from './tls-client.ts';
import type { TlsEngine, TlsStore } from './tls-engine.ts';
import type { ResolveFamily } from './uplink.ts';

export interface TlsClientSupport {
  engine: () => Promise<TlsEngine>;
  roots: () => Promise<Uint8Array>;
}

export interface SecureRequest {
  servername?: string;
  alpn?: string[];
  ca?: true | string[];
  insecure?: boolean;
}

export interface SecureProcess {
  net: LoopbackNet;
  blocking(): AbortSignal;
  resolve(name: string, family: ResolveFamily, blocking: () => AbortSignal): Promise<string[]>;
}

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

function base64Der(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface SecureSession {
  path: 'kernel';
  substitutes: false;
  protocol: TlsClientInfo['protocol'];
  alpnProtocol: string | false;
  authorized: boolean;
  authorizationError?: string;
  authorizationText?: string;
  servername: string;
  peerCertificates: string[];
}

function sessionOf(info: TlsClientInfo, servername: string): SecureSession {
  return {
    path: 'kernel',
    substitutes: false,
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
  };
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

function secure(support: TlsClientSupport, req: SecureRequest, servername: string) {
  return async (raw: Parameters<Parameters<KernelSocket['upgradeSecure']>[0]>[0]) => {
    const { engine, store, own } = await setUp(support, req);
    try {
      return await tlsClient(raw, {
        engine,
        store,
        servername,
        alpn: req.alpn ?? [],
        insecure: req.insecure === true,
      });
    } finally {
      own?.release();
    }
  };
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
  const make = secure(support, req, servername);
  await socket.connectSecure({ family: 'inet', host: address, port }, route, async (conn) => {
    info = await conn.upgrade(make);
  });
  return sessionOf(info as TlsClientInfo, servername);
}

export async function upgradeSecure(
  proc: SecureProcess,
  socket: KernelSocket,
  req: SecureRequest
): Promise<SecureSession> {
  const peer = socket.peer;
  const host = req.servername || (peer?.family === 'inet' ? peer.host : '');
  const servername = serverName(host);
  const info = await socket.upgradeSecure(secure(supportOf(proc.net), req, servername));
  return sessionOf(info, servername);
}
