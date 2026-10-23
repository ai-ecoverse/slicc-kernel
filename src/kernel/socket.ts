import { wasiErrno } from '../process/wasi-errno.ts';
import type { Datagram, InetAddr, KernelDgram } from './dgram.ts';
import { type KernelErrno, KernelError, type KernelFile, type PollState } from './fd-table.ts';
import { type Destination, Routes } from './net/routes.ts';
import { SwitchConn } from './net/switch-conn.ts';
import type { TlsClientSupport } from './net/tls-uplink.ts';
import type { NetworkUplink, UplinkConn } from './net/uplink.ts';
import { hostPort, uplinkLink } from './net/uplink-socket.ts';
import { KernelPipe, PIPE_CAPACITY, PipeError } from './pipe.ts';
import type { SealedCaller } from './sealed.ts';
import type { UnixDgram } from './unix-dgram.ts';
export type SockAddr =
  | {
      family: 'inet';
      host: string;
      port: number;
    }
  | {
      family: 'unix';
      path: string;
    };
export type SocketDomain = SockAddr['family'];
const SOMAXCONN = 4096;
const EPHEMERAL_FIRST = 32768;
const EPHEMERAL_LAST = 60999;
const SOL_SOCKET = 1;
const SO_TYPE = 3;
const SO_ERROR = 4;
const SO_SNDBUF = 7;
const SO_RCVBUF = 8;
const SO_ACCEPTCONN = 30;
const SO_DOMAIN = 39;
const SOCK_STREAM = 1;
const AF_UNIX = 1;
const AF_INET = 2;
export const SHUT_RD = 0;
export const SHUT_WR = 1;
export const SHUT_RDWR = 2;
export const DIAL_TIMEOUT_MS = 30_000;
const DIAL_ERRORS: readonly KernelErrno[] = [
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
];
export interface UplinkRoute {
  uplink: NetworkUplink;
  routes: Routes;
  timeoutMs?: number;
}
function dialError(e: unknown, timedOut: boolean, closed: boolean): KernelError {
  if (timedOut) return new KernelError('ETIMEDOUT');
  if (closed) return new KernelError('ECONNABORTED');
  const code = (e as { code?: unknown } | null)?.code;
  const known = DIAL_ERRORS.find((errno) => errno === code);
  return new KernelError(known ?? 'EHOSTUNREACH');
}
export function isLoopback(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
async function pipeCall<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (e instanceof PipeError) throw new KernelError(e.code);
    throw e;
  }
}
export class Changes {
  private waiters: Array<() => void> = [];
  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new KernelError('EINTR'));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new KernelError('EINTR'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
interface Link {
  rx: KernelPipe;
  tx: KernelPipe;
}
function link(a: KernelSocket, b: KernelSocket): void {
  const ab = new KernelPipe();
  const ba = new KernelPipe();
  for (const pipe of [ab, ba]) {
    pipe.openRead();
    pipe.openWrite();
  }
  a.attach({ rx: ba, tx: ab });
  b.attach({ rx: ab, tx: ba });
}
export interface PeerCred {
  pid: number;
  uid: number;
  gid: number;
}
export type ConnectorStamp = SealedCaller;
export interface SocketName {
  key: string;
  typed: boolean;
}
const SERVE_CHUNK = 64 * 1024;

export class KernelSocket implements KernelFile {
  private readonly net: LoopbackNet;
  readonly domain: SocketDomain;
  private state: 'open' | 'connecting' | 'listening' | 'connected' | 'closed' = 'open';
  private dialing: AbortController | undefined;
  private failed: string | undefined;
  private reset: KernelError | undefined;
  local: SockAddr | undefined;
  peer: SockAddr | undefined;
  peerCred: PeerCred | undefined;
  peerStamp: ConnectorStamp | undefined;
  private listenerCred: PeerCred | undefined;
  private link: Link | undefined;
  private readShut = false;
  private writeShut = false;
  private readonly queue: KernelSocket[] = [];
  private backlog = 0;
  private boundAt: SockAddr | undefined;
  named: SocketName | undefined;
  private readonly changes = new Changes();
  private readonly room = new Changes();
  private readonly options = new Map<string, number>();
  constructor(net: LoopbackNet, domain: SocketDomain) {
    this.net = net;
    this.domain = domain;
  }
  attach(link: Link): void {
    this.link = link;
    this.state = 'connected';
    this.changes.wake();
  }
  get listening(): boolean {
    return this.state === 'listening';
  }
  get unconnected(): boolean {
    return this.state === 'open' || this.state === 'listening';
  }
  private connection(): Link {
    if (!this.link || this.state !== 'connected') throw new KernelError('ENOTCONN');
    return this.link;
  }
  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    const { rx } = this.connection();
    if (this.readShut || max <= 0) return new Uint8Array(0);
    const bytes = await pipeCall(() => rx.read(max, signal));
    if (bytes.length === 0 && this.reset) throw this.reset;
    return bytes;
  }
  async peek(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    const { rx } = this.connection();
    if (this.readShut || max <= 0) return new Uint8Array(0);
    const bytes = await pipeCall(() => rx.peek(max, signal));
    if (bytes.length === 0 && this.reset) throw this.reset;
    return bytes;
  }
  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    const { tx } = this.connection();
    if (this.writeShut) throw new KernelError('EPIPE');
    if (this.reset?.code === 'EPROTO') throw this.reset;
    return pipeCall(() => tx.write(bytes, signal));
  }
  poll(): PollState {
    if (this.state === 'listening') {
      return { readable: this.queue.length > 0, writable: false, hangup: false };
    }
    if (this.state === 'connecting') return { readable: false, writable: false, hangup: false };
    if (this.failed) return { readable: true, writable: true, hangup: true };
    if (this.state !== 'connected' || !this.link) {
      return { readable: false, writable: false, hangup: true };
    }
    const { rx, tx } = this.link;
    return {
      readable: this.readShut || rx.readReady,
      writable: this.writeShut || tx.writeReady,
      hangup: rx.writersGone && tx.readersGone,
      rdhup: rx.writersGone,
      nread: this.readShut ? 0 : rx.buffered,
    };
  }
  changed(signal?: AbortSignal): Promise<void> {
    const own = this.changes.wait(signal);
    if (this.state !== 'connected' || !this.link) return own;
    const waits = [own, this.link.rx.changed(signal), this.link.tx.changed(signal)];
    for (const wait of waits) wait.catch(() => undefined);
    return pipeCall(() => Promise.race(waits));
  }
  bindable(addr: SockAddr): void {
    if (this.state !== 'open' || this.local) throw new KernelError('EINVAL');
    if (addr.family !== this.domain) throw new KernelError('EAFNOSUPPORT');
  }
  bind(addr: SockAddr, kernel = false, name?: SocketName): void {
    this.bindable(addr);
    this.local = this.net.bind(this, addr, kernel, name);
    this.boundAt = this.local;
  }
  listen(backlog: number, cred?: PeerCred): void {
    if (this.state === 'connected') throw new KernelError('EISCONN');
    if (this.state !== 'open' && this.state !== 'listening') throw new KernelError('EINVAL');
    if (!this.local) {
      if (this.domain === 'unix') throw new KernelError('EINVAL');
      this.bind({ family: 'inet', host: '0.0.0.0', port: 0 });
    }
    this.backlog = Math.min(Math.max(backlog, 1), SOMAXCONN);
    this.state = 'listening';
    this.listenerCred ??= cred;
  }
  async accept(signal?: AbortSignal, nonblock = false): Promise<KernelSocket> {
    for (;;) {
      if (this.state !== 'listening') throw new KernelError('EINVAL');
      const next = this.queue.shift();
      if (next) {
        this.room.wake();
        return next;
      }
      if (nonblock) throw new KernelError('EAGAIN');
      await this.changes.wait(signal);
    }
  }
  offer(server: KernelSocket): boolean {
    if (this.state !== 'listening' || this.queue.length >= this.backlog) return false;
    this.queue.push(server);
    this.changes.wake();
    return true;
  }
  get full(): boolean {
    return this.state === 'listening' && this.queue.length >= this.backlog;
  }
  waitRoom(signal: AbortSignal): Promise<void> {
    return this.room.wait(signal);
  }
  connect(
    addr: SockAddr,
    viaUplink = true,
    cred?: PeerCred,
    stamp?: ConnectorStamp,
    waits = true,
    name?: SocketName
  ): Promise<void> | undefined {
    if (this.state === 'connected') throw new KernelError('EISCONN');
    if (this.state === 'connecting') throw new KernelError('EALREADY');
    if (this.state !== 'open') throw new KernelError('EINVAL');
    if (addr.family !== this.domain) throw new KernelError('EAFNOSUPPORT');
    this.failed = undefined;
    const route = viaUplink && addr.family === 'inet' ? this.net.uplinkFor(addr.host) : undefined;
    if (route) return this.dial(addr as Extract<SockAddr, { family: 'inet' }>, route);
    const target = this.net.target(addr, name);
    if (!this.local) {
      if (addr.family === 'inet') {
        this.local = this.net.bind(this, { family: 'inet', host: '127.0.0.1', port: 0 });
        this.boundAt = this.local;
      } else this.local = { family: 'unix', path: '' };
    }
    if (waits && target.full) return this.queued(addr, target, cred, stamp);
    this.join(addr, target, cred, stamp);
    return undefined;
  }
  private join(
    addr: SockAddr,
    target: KernelSocket,
    cred?: PeerCred,
    stamp?: ConnectorStamp
  ): void {
    const server = new KernelSocket(this.net, this.domain);
    server.local = addr.family === 'inet' ? { ...addr, host: canonicalHost(addr.host) } : addr;
    server.peer = this.local;
    server.peerCred = cred;
    server.peerStamp = stamp;
    this.peer = server.local;
    this.peerCred = target.listenerCred;
    link(this, server);
    if (!target.offer(server)) {
      this.unlink();
      server.close();
      throw new KernelError('ECONNREFUSED');
    }
  }
  private async queued(
    addr: SockAddr,
    target: KernelSocket,
    cred?: PeerCred,
    stamp?: ConnectorStamp
  ): Promise<void> {
    this.state = 'connecting';
    const abort = new AbortController();
    this.dialing = abort;
    const timer = setTimeout(
      () => abort.abort(new KernelError('ETIMEDOUT')),
      this.net.backlogWaitMs
    );
    try {
      while (target.full) await target.waitRoom(abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      this.state = 'open';
      this.join(addr, target, cred, stamp);
      this.dialing = undefined;
    } catch (e) {
      const reason = abort.signal.aborted ? abort.signal.reason : e;
      const error = reason instanceof KernelError ? reason : new KernelError('ECONNREFUSED');
      if (this.dialing === abort) {
        this.dialing = undefined;
        this.failed = error.code;
        if (this.state === 'connecting') this.state = 'open';
        this.changes.wake();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private switch: SwitchConn | undefined;
  connectSecure(
    addr: Extract<SockAddr, { family: 'inet' }>,
    route: UplinkRoute,
    secure: (conn: SwitchConn) => Promise<void>
  ): Promise<void> {
    if (this.state !== 'open') throw new KernelError('EISCONN');
    return this.dial(addr, route, secure);
  }
  serving: { release(): void } | undefined;
  private served = false;
  get loopbackLinked(): boolean {
    return this.state === 'connected' && !this.switch;
  }
  async secureLink<T>(
    make: (raw: UplinkConn) => Promise<{ conn: UplinkConn; info: T }>
  ): Promise<T> {
    const raw = this.connection();
    if (this.switch || this.served || this.writeShut || this.readShut)
      throw new KernelError('EINVAL');
    this.served = true;
    const view: UplinkConn = {
      localAddr: '',
      remoteAddr: '',
      read: async () => {
        const bytes = await raw.rx.read(SERVE_CHUNK);
        return bytes.length > 0 ? bytes : null;
      },
      write: (bytes) => raw.tx.write(bytes),
      closeWrite: () => raw.tx.closeWrite(),
      close: () => {
        raw.rx.closeRead();
        raw.tx.closeWrite();
      },
    };
    let made: { conn: UplinkConn; info: T };
    try {
      made = await make(view);
    } catch (err) {
      view.close();
      this.readShut = true;
      this.writeShut = true;
      this.changes.wake();
      throw err;
    }
    this.link = uplinkLink(made.conn, (err) => {
      this.reset =
        err instanceof KernelError && err.code === 'EPROTO' ? err : new KernelError('ECONNRESET');
      this.changes.wake();
    });
    this.changes.wake();
    return made.info;
  }
  upgradeSecure<T>(make: (raw: UplinkConn) => Promise<{ conn: UplinkConn; info: T }>): Promise<T> {
    if (this.state !== 'connected') throw new KernelError('ENOTCONN');
    if (!this.switch) throw new KernelError('EOPNOTSUPP');
    if (this.switch.upgraded || this.writeShut || this.readShut) throw new KernelError('EINVAL');
    return this.switch.upgrade(make);
  }
  private dial(
    addr: Extract<SockAddr, { family: 'inet' }>,
    route: UplinkRoute,
    secure?: (conn: SwitchConn) => Promise<void>
  ): Promise<void> {
    this.state = 'connecting';
    const abort = new AbortController();
    this.dialing = abort;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort(new KernelError('ETIMEDOUT'));
    }, route.timeoutMs ?? DIAL_TIMEOUT_MS);
    const abandoned = new Promise<never>((_, reject) => {
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
    });
    const { host, port } = addr;
    const dialled = new Promise<UplinkConn>((resolve) =>
      resolve(route.uplink.dial({ network: 'tcp', host, port, signal: abort.signal }))
    );
    dialled.then(
      (conn) => abort.signal.aborted && conn.close(),
      () => undefined
    );
    return Promise.race([dialled, abandoned])
      .then(
        async (raw) => {
          if (abort.signal.aborted) throw dialError(abort.signal.reason, timedOut, true);
          const conn = new SwitchConn(raw);
          if (secure) {
            clearTimeout(timer);
            try {
              await Promise.race([secure(conn), abandoned]);
            } catch (e) {
              conn.close();
              throw this.dialFailed(
                abort,
                e instanceof KernelError
                  ? e
                  : new KernelError('ENOTSUP', e instanceof Error ? e.message : String(e))
              );
            }
          }
          this.local = { family: 'inet', host: '0.0.0.0', port: 0, ...hostPort(conn.localAddr) };
          this.peer = { ...addr, ...hostPort(conn.remoteAddr) };
          this.dialing = undefined;
          this.switch = conn;
          this.attach(
            uplinkLink(conn, (err) => {
              this.reset =
                err instanceof KernelError && err.code === 'EPROTO'
                  ? err
                  : new KernelError('ECONNRESET');
              this.changes.wake();
            })
          );
        },
        (e: unknown) => {
          throw this.dialFailed(abort, dialError(e, timedOut, abort.signal.aborted));
        }
      )
      .finally(() => clearTimeout(timer));
  }
  private dialFailed(abort: AbortController, error: KernelError): KernelError {
    if (this.dialing === abort) {
      this.dialing = undefined;
      this.failed = error.code;
      this.state = 'open';
      this.changes.wake();
    }
    return error;
  }
  private unlink(): void {
    const link = this.link;
    if (link) {
      link.rx.closeRead();
      link.tx.closeWrite();
    }
    this.link = undefined;
    this.peer = undefined;
    this.state = 'open';
  }
  shutdown(how: number): void {
    const { rx, tx } = this.connection();
    if (how !== SHUT_RD && how !== SHUT_WR && how !== SHUT_RDWR) throw new KernelError('EINVAL');
    if (how !== SHUT_WR && !this.readShut) {
      this.readShut = true;
      rx.closeRead();
    }
    if (how !== SHUT_RD && !this.writeShut) {
      this.writeShut = true;
      tx.closeWrite();
    }
    this.changes.wake();
  }
  getOption(level: number, name: number): number {
    if (level === SOL_SOCKET) {
      switch (name) {
        case SO_TYPE:
          return SOCK_STREAM;
        case SO_ERROR: {
          const failed = this.failed;
          this.failed = undefined;
          return failed ? wasiErrno(failed) : 0;
        }
        case SO_ACCEPTCONN:
          return this.state === 'listening' ? 1 : 0;
        case SO_DOMAIN:
          return this.domain === 'inet' ? AF_INET : AF_UNIX;
        case SO_SNDBUF:
        case SO_RCVBUF:
          return this.options.get(`${level}:${name}`) ?? PIPE_CAPACITY;
      }
    }
    return this.options.get(`${level}:${name}`) ?? 0;
  }
  setOption(level: number, name: number, value: number): void {
    this.options.set(`${level}:${name}`, value);
  }
  close(): void {
    const was = this.state;
    this.state = 'closed';
    this.dialing?.abort(new KernelError('ECONNABORTED'));
    this.dialing = undefined;
    if (was === 'listening') {
      for (const pending of this.queue.splice(0)) pending.close();
      this.room.wake();
    }
    if (this.link) {
      if (!this.readShut) this.link.rx.closeRead();
      if (!this.writeShut) this.link.tx.closeWrite();
      this.readShut = true;
      this.writeShut = true;
    }
    if (this.boundAt) this.net.release(this.boundAt, this, this.named);
    this.boundAt = undefined;
    this.serving?.release();
    this.serving = undefined;
    this.changes.wake();
  }
  static pair(
    net: LoopbackNet,
    domain: SocketDomain,
    cred?: PeerCred
  ): [KernelSocket, KernelSocket] {
    const a = new KernelSocket(net, domain);
    const b = new KernelSocket(net, domain);
    a.peerCred = b.peerCred = cred;
    const name: SockAddr =
      domain === 'inet'
        ? { family: 'inet', host: '127.0.0.1', port: 0 }
        : { family: 'unix', path: '' };
    a.local = b.local = a.peer = b.peer = name;
    link(a, b);
    return [a, b];
  }
}
export function canonicalHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}
export function keyOf(addr: SockAddr, name?: SocketName): string {
  if (name) return `node:${name.key}`;
  return addr.family === 'inet' ? `inet:${addr.port}` : `unix:${addr.path}`;
}
const LOCAL_ONLY = new Routes();
export class LoopbackNet {
  private readonly bound = new Map<string, KernelSocket>();
  private readonly dgrams = new Map<number, KernelDgram>();
  private readonly dgramServices = new Map<number, (datagram: Datagram, to: InetAddr) => void>();
  private readonly unixDgrams = new Map<string, UnixDgram>();
  private readonly activators = new Map<string, () => void>();
  private readonly internal = new Set<number>();
  private readonly reserved = new Set<number>();
  private readonly facades = new Map<number, string>();
  private nextEphemeral = EPHEMERAL_FIRST;
  private route: UplinkRoute | undefined;
  private origins: ((conn: KernelSocket, origin: string) => Promise<void>) | undefined;
  useOrigins(serve: (conn: KernelSocket, origin: string) => Promise<void>): void {
    this.origins = serve;
  }
  serveOrigin(conn: KernelSocket, origin: string): void {
    if (!this.origins) throw new KernelError('ENETUNREACH');
    void this.origins(conn, origin).catch(() => conn.close());
  }
  useUplink(route: UplinkRoute): void {
    this.route = route;
  }
  tlsClient: TlsClientSupport | undefined;
  uplinkFor(host: string): UplinkRoute | undefined {
    const route = this.route;
    if (!route) return undefined;
    return this.destination(host) === 'uplink' ? route : undefined;
  }
  destination(host: string): Destination {
    return (this.route?.routes ?? LOCAL_ONLY).classify(host);
  }
  bindDgram(socket: KernelDgram, addr: SockAddr, kernel = false): InetAddr {
    if (addr.family !== 'inet') throw new KernelError('EAFNOSUPPORT');
    this.bindable(addr, kernel);
    const port = addr.port === 0 ? this.ephemeral() : addr.port;
    if (this.dgrams.has(port)) throw new KernelError('EADDRINUSE');
    this.dgrams.set(port, socket);
    return { ...addr, port };
  }
  bindUnixDgram(socket: UnixDgram, key: string): void {
    if (this.bound.has(key) || this.unixDgrams.has(key)) throw new KernelError('EADDRINUSE');
    this.unixDgrams.set(key, socket);
  }
  releaseUnixDgram(key: string, socket: UnixDgram): void {
    if (this.unixDgrams.get(key) === socket) this.unixDgrams.delete(key);
  }
  unixDgramAt(key: string): UnixDgram {
    const socket = this.unixDgrams.get(key);
    if (socket) return socket;
    throw new KernelError(this.bound.has(key) ? 'EPROTOTYPE' : 'ECONNREFUSED');
  }
  releaseDgram(addr: InetAddr, socket: KernelDgram): void {
    if (this.dgrams.get(addr.port) === socket) this.dgrams.delete(addr.port);
  }
  serveDgram(port: number, serve: (datagram: Datagram, to: InetAddr) => void): void {
    this.dgramServices.set(port, serve);
  }
  deliverDgram(port: number, datagram: Datagram, to?: InetAddr): boolean {
    const target = this.dgrams.get(port);
    if (target) return target.deliver(datagram);
    const service = this.dgramServices.get(port);
    if (!service) return false;
    service(datagram, to ?? { family: 'inet', host: '127.0.0.1', port });
    return true;
  }
  private bindable(addr: Extract<SockAddr, { family: 'inet' }>, kernel: boolean): void {
    if (addr.host !== '0.0.0.0' && !isLoopback(addr.host)) {
      throw new KernelError('EADDRNOTAVAIL');
    }
    if (!kernel && this.reserved.has(addr.port)) throw new KernelError('EADDRINUSE');
  }
  kernelOnly(port: number, reserve = false): boolean {
    if (reserve) this.internal.add(port);
    return this.internal.has(port);
  }
  reserve(port: number): void {
    this.reserved.add(port);
  }
  facade(port: number, name: string): void {
    this.reserve(port);
    this.kernelOnly(port, true);
    this.facades.set(port, name);
  }
  facadeAt(addr: SockAddr): string | undefined {
    if (addr.family !== 'inet' || !isLoopback(canonicalHost(addr.host))) return undefined;
    return this.facades.get(addr.port);
  }
  activate(addr: SockAddr, start: () => void): void {
    this.activators.set(keyOf(addr), start);
  }
  socket(domain: SocketDomain): KernelSocket {
    return new KernelSocket(this, domain);
  }
  listen(addr: SockAddr, backlog = 128): KernelSocket {
    const socket = this.socket(addr.family);
    socket.bind(addr, true);
    socket.listen(backlog);
    return socket;
  }
  backlogWaitMs = DIAL_TIMEOUT_MS;
  connect(addr: SockAddr): KernelSocket {
    const socket = this.socket(addr.family);
    void socket.connect(addr, false, undefined, undefined, false);
    return socket;
  }
  bind(socket: KernelSocket, addr: SockAddr, kernel = false, name?: SocketName): SockAddr {
    if (addr.family === 'unix') {
      if (addr.path === '') throw new KernelError('EINVAL');
    } else this.bindable(addr, kernel);
    const named =
      addr.family === 'inet' && addr.port === 0 ? { ...addr, port: this.ephemeral() } : addr;
    const key = keyOf(named, name);
    if ((this.bound.has(key) && !name) || this.unixDgrams.has(key)) {
      throw new KernelError('EADDRINUSE');
    }
    this.bound.set(key, socket);
    socket.named = name;
    return named;
  }
  release(addr: SockAddr, socket: KernelSocket, name?: SocketName): void {
    const key = keyOf(addr, name);
    if (this.bound.get(key) === socket) this.bound.delete(key);
  }
  target(addr: SockAddr, name?: SocketName): KernelSocket {
    if (addr.family === 'inet' && !isLoopback(canonicalHost(addr.host))) {
      throw new KernelError('ENETUNREACH');
    }
    const key = keyOf(addr, name);
    if (this.unixDgrams.has(key)) throw new KernelError('EPROTOTYPE');
    if (!this.bound.has(key)) this.activators.get(key)?.();
    const socket = this.bound.get(key);
    if (!socket?.listening) throw new KernelError('ECONNREFUSED');
    if (name && socket.named?.typed && !name.typed) throw new KernelError('ECONNREFUSED');
    return socket;
  }
  private ephemeral(): number {
    const span = EPHEMERAL_LAST - EPHEMERAL_FIRST + 1;
    for (let i = 0; i < span; i++) {
      const port = this.nextEphemeral;
      this.nextEphemeral = port === EPHEMERAL_LAST ? EPHEMERAL_FIRST : port + 1;
      const taken = this.bound.has(`inet:${port}`) || this.dgrams.has(port);
      if (!taken && !this.reserved.has(port)) return port;
    }
    throw new KernelError('EADDRINUSE');
  }
}
const namespaces = new Map<string, LoopbackNet>();
export function loopbackNet(owner: string): LoopbackNet {
  let net = namespaces.get(owner);
  if (!net) {
    net = new LoopbackNet();
    namespaces.set(owner, net);
  }
  return net;
}
export function ownerKey(
  owner:
    | {
        kind: string;
        scoopJid?: string;
      }
    | undefined
): string {
  return owner ? `${owner.kind}:${owner.scoopJid ?? ''}` : 'local';
}
