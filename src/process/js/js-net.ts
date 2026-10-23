import { E } from '../wasi/wasi-abi.ts';
import { JsCallError, type JsKernel } from './js-kernel.ts';
import type { JsSyncKernel } from './js-sync.ts';

export interface JsAddress {
  host: string;
  port: number;
}

export interface JsTlsSession {
  readonly path: 'transport' | 'kernel';
  readonly substitutes: boolean;
  readonly verified?: boolean;
  readonly verifiedBy?: 'bundled' | 'none';
  readonly protocol: 'transport' | 'TLSv1.2' | 'TLSv1.3';
  readonly alpnProtocol: string | false;
  readonly authorized: boolean;
  readonly authorizationError?: string;
  readonly servername: string;
  readonly peerCertificates?: readonly Uint8Array[];
  readonly cipher?: JsTlsCipher;
  readonly clientCertificate?: boolean;
  readonly sni?: boolean;
  readonly hostnameChecked?: boolean;
  readonly hostnameMatches?: boolean;
  readonly chainError?: string;
  readonly keylog?: readonly string[];
}

export interface JsTlsCipher {
  readonly name: string;
  readonly standardName: string;
  readonly version: 'TLSv1.0' | 'TLSv1.2' | 'TLSv1.3';
}

export interface JsTlsOptions {
  servername?: string;
  alpn?: string[];
  rejectUnauthorized?: boolean;
  ca?: unknown;
  path?: 'kernel' | 'transport';
  cert?: unknown;
  key?: unknown;
  passphrase?: string;
  pfx?: unknown;
  sni?: boolean;
  checkHostname?: boolean;
  server?: boolean;
  requestCert?: boolean;
  handshakeTimeout?: number;
  keylog?: boolean;
  select?: JsTlsSelect;
}

export interface JsTlsOffer {
  servername: string;
  protocols: string[];
}

export interface JsTlsChoice {
  context?: JsTlsContext | number;
  alpn?: string;
  refuse?: string | number;
}

export type JsTlsSelect = (
  offer: JsTlsOffer
) => JsTlsChoice | undefined | Promise<JsTlsChoice | undefined>;

export interface JsTlsContext {
  readonly fd: number;
  close(): Promise<void>;
}

export interface JsTlsContextOptions {
  cert: unknown;
  key: unknown;
  passphrase?: string;
}

export interface JsTlsServerSession {
  readonly path: 'kernel';
  readonly protocol: 'TLSv1.2' | 'TLSv1.3';
  readonly alpnProtocol: string | false;
  readonly servername: string;
  readonly authorized: boolean;
  readonly authorizationError?: string;
  readonly peerCertificates: readonly Uint8Array[];
  readonly cipher: JsTlsCipher;
  readonly keylog?: readonly string[];
}

export interface JsConnection {
  readonly fd: number;
  readonly tls?: JsTlsSession;
  readonly local: JsAddress;
  readonly remote: JsAddress;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface JsListener extends AsyncIterable<JsConnection> {
  readonly fd: number;
  readonly host: string;
  readonly port: number;
  accept(options?: { signal?: AbortSignal }): Promise<JsConnection>;
  close(): Promise<void>;
}

export interface JsListenOptions {
  port?: number;
  host?: string;
  backlog?: number;
  tls?: JsTlsOptions;
}

export interface JsConnectOptions {
  host?: string;
  port?: number;
  signal?: AbortSignal;
  tls?: JsTlsOptions;
  socket?: JsConnection;
}

export interface JsResolveOptions {
  family?: 0 | 4 | 6;
  signal?: AbortSignal;
}

export interface JsNet {
  listen(options?: JsListenOptions): Promise<JsListener>;
  connect(options: JsConnectOptions): Promise<JsConnection>;
  secure(conn: JsConnection, tls: JsTlsOptions): Promise<JsConnection>;
  tlsContext(options: JsTlsContextOptions): Promise<JsTlsContext>;
  resolve(name: string, options?: JsResolveOptions): Promise<string[]>;
}

interface WireSession {
  path?: 'transport' | 'kernel';
  substitutes?: boolean;
  verified?: boolean;
  verifiedBy?: 'bundled' | 'none';
  protocol?: 'TLSv1.2' | 'TLSv1.3';
  alpnProtocol: string | false;
  authorized?: boolean;
  authorizationError?: string;
  servername: string;
  peerCertificates?: string[];
  cipher?: JsTlsCipher;
  clientCertificate?: boolean;
  sni?: boolean;
  hostnameChecked?: boolean;
  hostnameMatches?: boolean;
  chainError?: string;
  keylog?: string[];
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const PEM = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

function caList(ca: unknown): string[] {
  const items = Array.isArray(ca) ? ca : [ca];
  const out: string[] = [];
  for (const item of items) {
    if (item instanceof Uint8Array && item[0] === 0x30) out.push(toBase64(item));
    else {
      const text = item instanceof Uint8Array ? new TextDecoder().decode(item) : String(item);
      out.push(...[...text.matchAll(PEM)].map((m) => (m[1] as string).replace(/\s+/g, '')));
    }
  }
  return out;
}

function keyText(key: unknown, what: string): string {
  if (key instanceof Uint8Array) return toBase64(key);
  if (typeof key === 'string') return toBase64(new TextEncoder().encode(key));
  throw new JsCallError('EINVAL', what, 'ERR_INVALID_ARG_TYPE: key must be a string or bytes');
}

function serveRequest(tls: JsTlsOptions) {
  const own = clientCert(tls, 'listen').clientCert;
  if (tls.select !== undefined && typeof tls.select !== 'function')
    throw new JsCallError('EINVAL', 'listen', 'ERR_INVALID_ARG_TYPE: select must be a function');
  if (!own && !tls.select)
    throw new JsCallError('EINVAL', 'listen', 'ERR_INVALID_ARG_VALUE: a server needs cert and key');
  return {
    ...(own ? { cert: own } : {}),
    ...(tls.select ? { select: true } : {}),
    ...(tls.ca !== undefined ? { ca: caList(tls.ca) } : {}),
    ...(tls.requestCert ? { requestCert: true } : {}),
    ...(tls.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
    ...(tls.alpn ? { alpn: [...tls.alpn] } : {}),
    ...(tls.handshakeTimeout !== undefined ? { handshakeTimeout: tls.handshakeTimeout } : {}),
    ...(tls.keylog === true ? { keylog: true } : {}),
  };
}

interface ServedWire {
  protocol: 'TLSv1.2' | 'TLSv1.3';
  alpnProtocol: string | false;
  servername: string;
  authorized: boolean;
  authorizationError?: string;
  peerCertificates: string[];
  cipher: JsTlsCipher;
  keylog?: string[];
}

function servedOf(r: ServedWire): JsTlsServerSession {
  const { authorizationError, ...rest } = r;
  return Object.freeze({
    ...rest,
    path: 'kernel',
    ...(authorizationError ? { authorizationError } : {}),
    peerCertificates: Object.freeze(r.peerCertificates.map(fromBase64)),
    cipher: Object.freeze({ ...r.cipher }),
    ...keylogOf(r.keylog),
  });
}

function keylogOf(lines: string[] | undefined): { keylog?: readonly string[] } {
  return lines ? { keylog: Object.freeze([...lines]) } : {};
}

function clientCert(tls: JsTlsOptions, what = 'connect') {
  if (tls.pfx !== undefined) {
    throw new JsCallError('ENOTSUP', what, 'pfx is not supported: pass cert and key');
  }
  if (tls.cert === undefined && tls.key === undefined) return {};
  const chain = tls.cert === undefined ? [] : caList(tls.cert);
  if (chain.length === 0 || tls.key === undefined) {
    throw new JsCallError('EINVAL', what, 'ERR_INVALID_ARG_VALUE: cert and key go together');
  }
  const passphrase = tls.passphrase === undefined ? {} : { passphrase: String(tls.passphrase) };
  return { clientCert: { chain, key: keyText(tls.key, what), ...passphrase } };
}

function tlsRequest(tls: JsTlsOptions) {
  return {
    ...(tls.servername ? { servername: tls.servername } : {}),
    ...(tls.alpn ? { alpn: [...tls.alpn] } : {}),
    ...(tls.ca !== undefined ? { ca: caList(tls.ca) } : {}),
    ...(tls.rejectUnauthorized === false ? { insecure: true } : {}),
    ...(tls.sni === false ? { sni: false as const } : {}),
    ...(tls.checkHostname === false ? { checkHostname: false as const } : {}),
    ...(tls.keylog === true ? { keylog: true } : {}),
    ...clientCert(tls),
  };
}

function controlsOf(r: WireSession) {
  if (!r.cipher) return {};
  return {
    cipher: Object.freeze({ ...r.cipher }),
    clientCertificate: r.clientCertificate === true,
    sni: r.sni !== false,
    hostnameChecked: r.hostnameChecked === true,
    ...(r.hostnameMatches === undefined ? {} : { hostnameMatches: r.hostnameMatches }),
    ...(r.chainError ? { chainError: r.chainError } : {}),
  };
}

function sessionOf(r: WireSession): JsTlsSession {
  if (r.path !== 'kernel') {
    return Object.freeze({
      path: 'transport',
      substitutes: true,
      protocol: 'transport',
      alpnProtocol: r.alpnProtocol,
      authorized: true,
      servername: r.servername,
    });
  }
  return Object.freeze({
    path: 'kernel',
    substitutes: r.substitutes === true,
    verified: r.verified === true,
    verifiedBy: r.verifiedBy === 'bundled' ? 'bundled' : 'none',
    protocol: r.protocol ?? 'TLSv1.2',
    alpnProtocol: r.alpnProtocol,
    authorized: r.authorized === true,
    ...(r.authorizationError ? { authorizationError: r.authorizationError } : {}),
    servername: r.servername,
    peerCertificates: Object.freeze((r.peerCertificates ?? []).map(fromBase64)),
    ...controlsOf(r),
    ...keylogOf(r.keylog),
  });
}

const TLS_CODE = /^([A-Z][A-Z0-9_]+): /;

const ALERT = / \(alert (\d+)\)$/;

function withAlert(err: JsCallError): JsCallError {
  const alert = ALERT.exec(err.detail ?? '')?.[1];
  return alert === undefined ? err : Object.assign(err, { alert: Number(alert) });
}

async function secureCall<T>(call: () => Promise<T>, what = 'connect'): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const e = err as JsCallError;
    const code = e.code === 'EPROTO' && e.detail ? TLS_CODE.exec(e.detail)?.[1] : undefined;
    if (code) throw withAlert(new JsCallError(code, what, e.detail));
    throw err;
  }
}

export interface NetIo {
  read(fd: number, max: number | undefined, signal: AbortSignal): Promise<Uint8Array>;
  send(fd: number, data: Uint8Array, signal: AbortSignal): Promise<void>;
  close(fd: number): Promise<void>;
}

interface InetAddr {
  family: 'inet';
  host: string;
  port: number;
}

const SHUT_RD = 0;
const SHUT_WR = 1;
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const NEVER = new AbortController().signal;
const SOL_SOCKET = 1;
const SO_ERROR = 4;

function errnoName(errno: number): string {
  const found = Object.entries(E).find(([, n]) => n === errno);
  return found ? `E${found[0]}` : 'EIO';
}

function addressOf(addr: unknown): JsAddress {
  const inet = addr as InetAddr;
  return { host: inet.host, port: inet.port };
}

function port(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new JsCallError('EINVAL', `port ${n}`);
  return n;
}

export interface JsSyncNet {
  listen(options?: JsListenOptions): JsListener;
}

const ALERTS: Record<string, number> = {
  unrecognized_name: 112,
  no_application_protocol: 120,
  handshake_failure: 40,
  access_denied: 49,
  internal_error: 80,
};

function choiceWire(choice: JsTlsChoice | undefined) {
  if (!choice) return {};
  const { context, alpn, refuse } = choice;
  return {
    ...(context === undefined
      ? {}
      : { context: typeof context === 'number' ? context : context.fd }),
    ...(alpn === undefined ? {} : { alpn: String(alpn) }),
    ...(refuse === undefined ? {} : { refuse: ALERTS[String(refuse)] ?? Number(refuse) }),
  };
}

type Selected = { wire: object; thrown?: unknown };

const HANDSHAKE_TIMEOUT_MS = 120_000;

function expiry(ms: number): { late: Promise<never>; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new JsCallError('ERR_TLS_HANDSHAKE_TIMEOUT', 'accept', 'ERR_TLS_HANDSHAKE_TIMEOUT')),
      ms
    );
  });
  late.catch(() => undefined);
  return { late, clear: () => clearTimeout(timer) };
}

async function selected(
  pick: JsTlsSelect | undefined,
  offer: JsTlsOffer,
  ms: number
): Promise<Selected> {
  const limit = expiry(ms);
  try {
    if (!pick) return { wire: {} };
    const choice = await Promise.race([pick(Object.freeze({ ...offer })), limit.late]);
    return { wire: choiceWire(choice) };
  } catch (thrown) {
    return { wire: { refuse: ALERTS.handshake_failure }, thrown };
  } finally {
    limit.clear();
  }
}

async function serveOn(
  kernel: JsKernel,
  conn: JsConnection,
  req: object,
  signal: AbortSignal = NEVER,
  pick?: JsTlsSelect,
  ms = HANDSHAKE_TIMEOUT_MS
): Promise<JsConnection> {
  const call = (body: object) =>
    secureCall(async () => {
      const r = await kernel.blocking(body as Parameters<JsKernel['blocking']>[0], signal);
      return (r.ok && r.kind === 'json' ? r.json : {}) as ServedWire & { select?: JsTlsOffer };
    }, 'accept');
  let wire = await call({ op: 'sock-tls-serve', fd: conn.fd, ...req });
  while (wire.select) {
    const { wire: choice, thrown } = await selected(pick, wire.select, ms);
    wire = await call({ op: 'sock-tls-select', fd: conn.fd, ...choice }).catch((err) => {
      throw thrown ?? err;
    });
  }
  return Object.assign(Object.create(conn), { tls: servedOf(wire) });
}

export const HANDSHAKES_MAX = 64;

function changeOf(waiters: Set<() => void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      waiters.delete(done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    waiters.add(done);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function securedAccepts(
  plain: (signal: AbortSignal) => Promise<JsConnection>,
  serve: (conn: JsConnection, signal: AbortSignal) => Promise<JsConnection>,
  stop: AbortSignal,
  cap: number
): (signal: AbortSignal) => Promise<JsConnection> {
  const ready: JsConnection[] = [];
  const waiters = new Set<() => void>();
  let failure: unknown;
  let pumping = false;
  let inFlight = 0;
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const handshake = (conn: JsConnection) => {
    inFlight++;
    serve(conn, stop)
      .then(
        (secured) => {
          if (stop.aborted) void secured.close();
          else ready.push(secured);
        },
        () => conn.close()
      )
      .finally(() => {
        inFlight--;
        wake();
      });
  };
  const pump = async () => {
    for (;;) {
      try {
        while (inFlight + ready.length >= cap) {
          stop.throwIfAborted();
          await changeOf(waiters, stop);
        }
        handshake(await plain(stop));
      } catch (err) {
        failure = err;
        for (const left of ready.splice(0)) void left.close();
        wake();
        return;
      }
    }
  };
  return async (signal) => {
    if (!pumping) {
      pumping = true;
      void pump();
    }
    for (;;) {
      if (stop.aborted) throw stop.reason;
      const next = ready.shift();
      if (next) {
        wake();
        return next;
      }
      if (failure !== undefined) throw failure;
      signal.throwIfAborted();
      await changeOf(waiters, signal);
    }
  };
}

interface ListenerOps {
  kernel: JsKernel;
  io: NetIo;
  connection(fd: number): Promise<JsConnection>;
  serve(
    conn: JsConnection,
    req: object,
    signal?: AbortSignal,
    pick?: JsTlsSelect,
    ms?: number
  ): Promise<JsConnection>;
}

function listenerOf(
  ops: ListenerOps,
  fd: number,
  at: JsAddress,
  handshakes: number,
  tls?: JsTlsOptions
): JsListener {
  const { kernel, io, connection, serve } = ops;
  const stop = new AbortController();
  const acceptPlain = async (signal: AbortSignal): Promise<JsConnection> => {
    for (;;) {
      signal.throwIfAborted();
      const r = await kernel.raw({ op: 'sock-accept', fd, nonblock: true });
      if (r.ok) return connection(((r.kind === 'json' ? r.json : {}) as { fd: number }).fd);
      if (r.errno !== 'EAGAIN') throw new JsCallError(r.errno, 'accept');
      await kernel.blocking({ op: 'fd-select', read: [fd], write: [], timeoutMs: -1 }, signal);
    }
  };
  const next =
    handshakes > 0
      ? securedAccepts(
          acceptPlain,
          (c, s) => serve(c, { from: fd }, s, tls?.select, tls?.handshakeTimeout),
          stop.signal,
          handshakes
        )
      : acceptPlain;
  const accept = (options: { signal?: AbortSignal } = {}): Promise<JsConnection> =>
    next(AbortSignal.any([options.signal ?? NEVER, stop.signal]));
  return {
    fd,
    ...at,
    accept,
    async close() {
      stop.abort(new JsCallError('EBADF', 'listener closed'));
      await io.close(fd);
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        try {
          yield await accept();
        } catch (err) {
          if (stop.signal.aborted) return;
          throw err;
        }
      }
    },
  };
}

async function contextOf(
  kernel: JsKernel,
  io: NetIo,
  options: JsTlsContextOptions
): Promise<JsTlsContext> {
  const own = clientCert(options ?? {}, 'tlsContext').clientCert;
  if (!own)
    throw new JsCallError(
      'EINVAL',
      'tlsContext',
      'ERR_INVALID_ARG_VALUE: a context needs cert and key'
    );
  const fd = (await secureCall(
    () => kernel.json({ op: 'sock-tls-context', cert: own }),
    'tlsContext'
  )) as number;
  let closed: Promise<void> | undefined;
  return Object.freeze({
    fd,
    close: () => {
      closed ??= io.close(fd);
      return closed;
    },
  });
}

function capOf(options: JsListenOptions, tls: object | undefined): number {
  return tls ? Math.max(1, Math.min(options.backlog ?? 128, HANDSHAKES_MAX)) : 0;
}

export function netOps(
  kernel: JsKernel,
  io: NetIo,
  sync?: JsSyncKernel
): JsNet & { sync: JsSyncNet } {
  const name = async (fd: number, peer: boolean): Promise<JsAddress> =>
    addressOf(await kernel.json({ op: 'sock-name', fd, peer }));

  const connection = async (fd: number): Promise<JsConnection> => {
    const [local, remote] = [await name(fd, false), await name(fd, true)];
    const stop = new AbortController();
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
      stop.abort(new JsCallError('EBADF', 'socket closed'));
      closed ??= io.close(fd);
      return closed;
    };
    const shut = (how: number): Promise<unknown> => kernel.raw({ op: 'sock-shutdown', fd, how });
    const readable = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const chunk = await secureCall(() => io.read(fd, undefined, stop.signal), 'read');
          if (chunk.length > 0) controller.enqueue(chunk);
          else controller.close();
        },
        cancel: async () => void (await shut(SHUT_RD)),
      },
      { highWaterMark: 0 }
    );
    const writable = new WritableStream<Uint8Array>({
      write: (chunk, controller) =>
        secureCall(
          () => io.send(fd, chunk, AbortSignal.any([controller.signal, stop.signal])),
          'write'
        ),
      close: async () => void (await shut(SHUT_WR)),
      abort: () => close(),
    });
    return { fd, local, remote, readable, writable, close };
  };

  const resolve = async (host: string, signal: AbortSignal): Promise<string> => {
    if (IPV4.test(host)) return host;
    const r = await kernel.blocking({ op: 'sock-resolve', name: host, family: 4 }, signal);
    return ((r.ok && r.kind === 'json' ? r.json : []) as string[])[0] as string;
  };

  const opened = async <T>(use: (fd: number) => Promise<T>): Promise<T> => {
    const fd = (await kernel.json({ op: 'sock-open', domain: 'inet' })) as number;
    try {
      return await use(fd);
    } catch (err) {
      await io.close(fd);
      throw err;
    }
  };

  const serve: ListenerOps['serve'] = (...args) => serveOn(kernel, ...args);

  const ops: ListenerOps = { kernel, io, connection, serve };
  const listener = (fd: number, at: JsAddress, handshakes = 0, tls?: JsTlsOptions): JsListener =>
    listenerOf(ops, fd, at, handshakes, tls);

  const connect = async (options: JsConnectOptions): Promise<JsConnection> => {
    const signal = options.signal ?? NEVER;
    const host = options.host ?? '127.0.0.1';
    if (host.includes(':')) throw new JsCallError('EADDRNOTAVAIL', host);
    const addr: InetAddr = {
      family: 'inet',
      host: await resolve(host, signal),
      port: port(options.port as number),
    };
    return opened(async (fd) => {
      const r = await kernel.raw({ op: 'sock-connect', fd, addr, nonblock: true });
      if (!r.ok && r.errno !== 'EINPROGRESS') throw new JsCallError(r.errno, 'connect');
      await kernel.blocking({ op: 'fd-select', read: [], write: [fd], timeoutMs: -1 }, signal);
      const failed = (await kernel.json({
        op: 'sock-getopt',
        fd,
        level: SOL_SOCKET,
        name: SO_ERROR,
      })) as number;
      if (failed !== 0) throw new JsCallError(errnoName(failed), 'connect');
      return connection(fd);
    });
  };

  const tlsConnect = async (
    options: JsConnectOptions,
    tls: JsTlsOptions
  ): Promise<JsConnection> => {
    const host = options.host ?? 'localhost';
    if (!options.socket && LOOPBACK.test(host)) {
      const { tls: _, ...plain } = options;
      const socket = await connect({ ...plain, host });
      return tlsConnect({ ...plain, host, socket }, tls).catch(async (err: unknown) => {
        await socket.close();
        throw err;
      });
    }
    const common = tlsRequest(
      options.socket && !tls.servername && options.host ? { ...tls, servername: options.host } : tls
    );
    const r = (await secureCall(async () => {
      if (!options.socket)
        return kernel.json({
          op: 'sock-tls',
          host,
          port: port(options.port as number),
          ...common,
          ...(tls.path ? { path: tls.path } : {}),
        });
      const req = { op: 'sock-tls-upgrade' as const, fd: options.socket.fd, ...common };
      const done = await kernel.blocking(req, options.signal ?? NEVER);
      return done.ok && done.kind === 'json' ? done.json : undefined;
    })) as WireSession & { fd?: number };
    const session = sessionOf(r);
    if (options.socket) return Object.assign(Object.create(options.socket), { tls: session });
    return Object.assign(await connection(r.fd as number), { tls: session });
  };

  const lookup = async (name: string, options: JsResolveOptions = {}): Promise<string[]> => {
    const family = options.family ?? 0;
    if (family !== 0 && family !== 4 && family !== 6) {
      throw new JsCallError('EAI_FAMILY', `resolve ${name}`);
    }
    const signal = options.signal ?? NEVER;
    signal.throwIfAborted();
    const req = { op: 'sock-resolve' as const, name: String(name), family };
    const r = await kernel.blocking(req, signal).catch((err: unknown) => {
      signal.throwIfAborted();
      const code = (err as { code?: unknown }).code;
      if (code === 'ETIMEDOUT') throw new JsCallError('EAI_AGAIN', `resolve ${name}`);
      if (code !== 'ENOENT') throw err;
      throw new JsCallError('ENOTFOUND', `resolve ${name}`);
    });
    return [...((r.ok && r.kind === 'json' ? r.json : []) as string[])];
  };

  const inetAt = (options: JsListenOptions): InetAddr => ({
    family: 'inet',
    host: options.host ?? '127.0.0.1',
    port: port(options.port ?? 0),
  });

  const listenSync = (options: JsListenOptions = {}): JsListener => {
    const lane = sync as JsSyncKernel;
    const addr = inetAt(options);
    const tls = options.tls ? serveRequest(options.tls) : undefined;
    const fd = lane.json({ op: 'sock-open', domain: 'inet' }) as number;
    try {
      lane.call({ op: 'sock-bind', fd, addr });
      lane.call({ op: 'sock-listen', fd, backlog: options.backlog ?? 128 });
      if (tls) lane.call({ op: 'sock-tls-listen', fd, ...tls });
      const at = addressOf(lane.json({ op: 'sock-name', fd, peer: false }));
      return listener(fd, at, capOf(options, tls), options.tls);
    } catch (err) {
      lane.raw({ op: 'fd-close', fd });
      throw err;
    }
  };

  return {
    sync: { listen: listenSync },
    resolve: lookup,
    listen: async (options = {}) => {
      const tls = options.tls ? serveRequest(options.tls) : undefined;
      return opened(async (fd) => {
        const addr = inetAt(options);
        await kernel.call({ op: 'sock-bind', fd, addr });
        await kernel.call({ op: 'sock-listen', fd, backlog: options.backlog ?? 128 });
        if (tls)
          await secureCall(() => kernel.call({ op: 'sock-tls-listen', fd, ...tls }), 'listen');
        return listener(fd, await name(fd, false), capOf(options, tls), options.tls);
      });
    },
    secure: async (conn, tls) => {
      if (tls.server !== true) return tlsConnect({ socket: conn }, tls);
      return serve(conn, serveRequest(tls), undefined, tls.select, tls.handshakeTimeout);
    },
    tlsContext: (options) => contextOf(kernel, io, options),
    connect: (options) => {
      (options.signal ?? NEVER).throwIfAborted();
      return options.tls ? tlsConnect(options, options.tls) : connect(options);
    },
  };
}
