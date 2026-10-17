import { E } from '../wasi/wasi-abi.ts';
import { JsCallError, type JsKernel } from './js-kernel.ts';

export interface JsAddress {
  host: string;
  port: number;
}

export interface JsTlsSession {
  readonly path: 'transport' | 'kernel';
  readonly substitutes: boolean;
  readonly protocol: 'transport' | 'TLSv1.2' | 'TLSv1.3';
  readonly alpnProtocol: string | false;
  readonly authorized: boolean;
  readonly authorizationError?: string;
  readonly servername: string;
  readonly peerCertificates?: readonly Uint8Array[];
}

export interface JsTlsOptions {
  servername?: string;
  alpn?: string[];
  rejectUnauthorized?: boolean;
  ca?: unknown;
  path?: 'kernel' | 'transport';
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
  resolve(name: string, options?: JsResolveOptions): Promise<string[]>;
}

interface WireSession {
  path?: 'transport' | 'kernel';
  substitutes?: boolean;
  protocol?: 'TLSv1.2' | 'TLSv1.3';
  alpnProtocol: string | false;
  authorized?: boolean;
  authorizationError?: string;
  servername: string;
  peerCertificates?: string[];
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

function tlsRequest(tls: JsTlsOptions) {
  return {
    ...(tls.servername ? { servername: tls.servername } : {}),
    ...(tls.alpn ? { alpn: [...tls.alpn] } : {}),
    ...(tls.ca !== undefined ? { ca: caList(tls.ca) } : {}),
    ...(tls.rejectUnauthorized === false ? { insecure: true } : {}),
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
    substitutes: false,
    protocol: r.protocol ?? 'TLSv1.2',
    alpnProtocol: r.alpnProtocol,
    authorized: r.authorized === true,
    ...(r.authorizationError ? { authorizationError: r.authorizationError } : {}),
    servername: r.servername,
    peerCertificates: Object.freeze((r.peerCertificates ?? []).map(fromBase64)),
  });
}

const TLS_CODE = /^([A-Z][A-Z0-9_]+): /;

async function secureCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const e = err as JsCallError;
    const code = e.code === 'EPROTO' && e.detail ? TLS_CODE.exec(e.detail)?.[1] : undefined;
    if (code) throw new JsCallError(code, 'connect', e.detail);
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

export function netOps(kernel: JsKernel, io: NetIo): JsNet {
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
          const chunk = await io.read(fd, undefined, stop.signal);
          if (chunk.length > 0) controller.enqueue(chunk);
          else controller.close();
        },
        cancel: async () => void (await shut(SHUT_RD)),
      },
      { highWaterMark: 0 }
    );
    const writable = new WritableStream<Uint8Array>({
      write: (chunk, controller) =>
        io.send(fd, chunk, AbortSignal.any([controller.signal, stop.signal])),
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

  const listener = (fd: number, at: JsAddress): JsListener => {
    const stop = new AbortController();
    const accept = async (options: { signal?: AbortSignal } = {}): Promise<JsConnection> => {
      const signal = AbortSignal.any([options.signal ?? NEVER, stop.signal]);
      for (;;) {
        signal.throwIfAborted();
        const r = await kernel.raw({ op: 'sock-accept', fd, nonblock: true });
        if (r.ok) return connection(((r.kind === 'json' ? r.json : {}) as { fd: number }).fd);
        if (r.errno !== 'EAGAIN') throw new JsCallError(r.errno, 'accept');
        await kernel.blocking({ op: 'fd-select', read: [fd], write: [], timeoutMs: -1 }, signal);
      }
    };
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
  };

  const tlsConnect = async (
    options: JsConnectOptions,
    tls: JsTlsOptions
  ): Promise<JsConnection> => {
    const common = tlsRequest(
      options.socket && !tls.servername && options.host ? { ...tls, servername: options.host } : tls
    );
    const r = (await secureCall(() =>
      kernel.json(
        options.socket
          ? { op: 'sock-tls-upgrade', fd: options.socket.fd, ...common }
          : {
              op: 'sock-tls',
              host: options.host ?? 'localhost',
              port: port(options.port as number),
              ...common,
              ...(tls.path ? { path: tls.path } : {}),
            }
      )
    )) as WireSession & { fd?: number };
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
      if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
      throw new JsCallError('ENOTFOUND', `resolve ${name}`);
    });
    return [...((r.ok && r.kind === 'json' ? r.json : []) as string[])];
  };

  return {
    resolve: lookup,
    listen: (options = {}) =>
      opened(async (fd) => {
        const addr: InetAddr = {
          family: 'inet',
          host: options.host ?? '127.0.0.1',
          port: port(options.port ?? 0),
        };
        await kernel.call({ op: 'sock-bind', fd, addr });
        await kernel.call({ op: 'sock-listen', fd, backlog: options.backlog ?? 128 });
        return listener(fd, await name(fd, false));
      }),
    connect: async (options) => {
      const signal = options.signal ?? NEVER;
      signal.throwIfAborted();
      if (options.tls) return tlsConnect(options, options.tls);
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
    },
  };
}
