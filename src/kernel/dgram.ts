import { wasiErrno } from '../process/wasi-errno.ts';
import { type KernelErrno, KernelError, type KernelFile, type PollState } from './fd-table.ts';
import { carriesUdp, type NetworkUplink, type UplinkUdp } from './net/uplink.ts';
import { Changes, canonicalHost, type LoopbackNet, type SockAddr } from './socket.ts';

export type InetAddr = Extract<SockAddr, { family: 'inet' }>;

export interface Datagram {
  bytes: Uint8Array;
  from: InetAddr;
}

export interface Received {
  bytes: Uint8Array;
  from: InetAddr;
  truncated: boolean;
}

export const DGRAM_QUEUE_BYTES = 256 * 1024;
export const DGRAM_QUEUE_COUNT = 512;
export const DGRAM_SEND_ROOM = 256 * 1024;
export const MAX_DATAGRAM_V4 = 65_507;
export const MAX_DATAGRAM_V6 = 65_527;

const SOL_SOCKET = 1;
const IPPROTO_IP = 0;
const SO_TYPE = 3;
const SO_ERROR = 4;
const SO_BROADCAST = 6;
const SO_SNDBUF = 7;
const SO_RCVBUF = 8;
const SO_DOMAIN = 39;
const SOCK_DGRAM = 2;
const AF_INET = 2;
const IP_MULTICAST_FIRST = 32;
const IP_MULTICAST_LAST = 36;
const SEND_ERRORS: readonly KernelErrno[] = ['ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EMSGSIZE'];
const UNREACHABLE: readonly KernelErrno[] = ['EACCES', 'ENETUNREACH', 'EHOSTUNREACH'];

function sendError(e: unknown): KernelError {
  if (e instanceof KernelError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  return new KernelError(SEND_ERRORS.find((errno) => errno === code) ?? 'EHOSTUNREACH');
}

function sameAddr(a: InetAddr, b: InetAddr): boolean {
  return a.port === b.port && canonicalHost(a.host) === canonicalHost(b.host);
}

function familyOf(host: string): 4 | 6 {
  return host.includes(':') ? 6 : 4;
}

export class KernelDgram implements KernelFile {
  local: InetAddr | undefined;
  peer: InetAddr | undefined;
  private readonly net: LoopbackNet;
  private readonly queue: Datagram[] = [];
  private queued = 0;
  private pending: KernelErrno | undefined;
  private closed = false;
  private sending = 0;
  private readonly changes = new Changes();
  private readonly options = new Map<string, number>();
  private readonly uplinks = new Map<4 | 6, Promise<UplinkUdp>>();
  private readonly stop = new AbortController();

  constructor(net: LoopbackNet) {
    this.net = net;
  }

  bind(addr: SockAddr): void {
    if (this.local) throw new KernelError('EINVAL');
    this.local = this.net.bindDgram(this, addr);
  }

  private bound(): InetAddr {
    this.local ??= this.net.bindDgram(this, { family: 'inet', host: '0.0.0.0', port: 0 });
    return this.local;
  }

  connectTo(addr: SockAddr): void {
    if (addr.family !== 'inet') throw new KernelError('EAFNOSUPPORT');
    this.route(addr.host);
    this.bound();
    this.peer = { family: 'inet', host: canonicalHost(addr.host), port: addr.port };
    this.pending = undefined;
    this.drain((d) => sameAddr(d.from, addr));
  }

  private drain(keep: (datagram: Datagram) => boolean): void {
    const kept = this.queue.filter(keep);
    this.queue.splice(0, this.queue.length, ...kept);
    this.queued = kept.reduce((sum, d) => sum + d.bytes.length, 0);
  }

  private route(host: string): 'loopback' | 'uplink' {
    const where = this.net.destination(host);
    if (where === 'loopback' || where === 'uplink') return where;
    throw new KernelError('ENETUNREACH');
  }

  private takeError(): KernelErrno | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  async send(bytes: Uint8Array, to?: SockAddr): Promise<number> {
    if (this.closed) throw new KernelError('EBADF');
    const pending = this.takeError();
    if (pending) throw new KernelError(pending);
    const target = to ?? this.peer;
    if (!target) throw new KernelError('EDESTADDRREQ');
    if (target.family !== 'inet') throw new KernelError('EAFNOSUPPORT');
    const max = familyOf(target.host) === 6 ? MAX_DATAGRAM_V6 : MAX_DATAGRAM_V4;
    if (bytes.length > max) throw new KernelError('EMSGSIZE');
    const where = this.route(target.host);
    const local = this.bound();
    if (where === 'uplink') return this.sendUp(bytes, target);
    const from: InetAddr = {
      family: 'inet',
      host: local.host === '0.0.0.0' ? '127.0.0.1' : local.host,
      port: local.port,
    };
    const delivered = this.net.deliverDgram(target.port, { bytes: bytes.slice(), from });
    if (!delivered && this.peer && sameAddr(this.peer, target)) {
      this.pending = 'ECONNREFUSED';
      this.changes.wake();
    }
    return bytes.length;
  }

  private async sendUp(bytes: Uint8Array, to: InetAddr): Promise<number> {
    const uplink = this.net.uplinkFor(to.host)?.uplink;
    if (!uplink || !carriesUdp(uplink)) throw new KernelError('ENETUNREACH');
    this.sending += bytes.length;
    try {
      const socket = await this.uplinkSocket(uplink, familyOf(to.host));
      await socket.send(bytes.slice(), to.host, to.port);
    } catch (e) {
      throw sendError(e);
    } finally {
      this.sending -= bytes.length;
      this.changes.wake();
    }
    return bytes.length;
  }

  private uplinkSocket(uplink: NetworkUplink, family: 4 | 6): Promise<UplinkUdp> {
    const known = this.uplinks.get(family);
    if (known !== undefined) return known;
    const opening = Promise.resolve().then(() => {
      if (!uplink.udp) throw new KernelError('ENETUNREACH');
      return uplink.udp({ family, signal: this.stop.signal });
    });
    this.uplinks.set(family, opening);
    opening.then(
      (socket) => {
        if (this.closed) {
          socket.close();
          return;
        }
        void this.pump(socket, family);
      },
      () => this.uplinks.delete(family)
    );
    return opening;
  }

  private async pump(socket: UplinkUdp, family: 4 | 6): Promise<void> {
    const iterate = async (): Promise<void> => {
      for await (const message of socket.messages) {
        if (this.closed) return;
        const from: InetAddr = { family: 'inet', host: message.host, port: message.port };
        if ('bytes' in message) this.deliver({ bytes: message.bytes, from });
        else this.unreachable(message.error, from);
      }
    };
    await iterate().catch(() => undefined);
    if (!this.closed) this.uplinks.delete(family);
    socket.close();
  }

  private unreachable(error: string, from: InetAddr): void {
    if (!this.peer || !sameAddr(this.peer, from)) return;
    this.pending = UNREACHABLE.find((errno) => errno === error) ?? 'EHOSTUNREACH';
    this.changes.wake();
  }

  deliver(datagram: Datagram): boolean {
    if (this.closed) return false;
    if (this.peer && !sameAddr(this.peer, datagram.from)) return true;
    const full =
      this.queue.length >= DGRAM_QUEUE_COUNT ||
      this.queued + datagram.bytes.length > DGRAM_QUEUE_BYTES;
    if (full) return true;
    this.queue.push(datagram);
    this.queued += datagram.bytes.length;
    this.changes.wake();
    return true;
  }

  async receive(max: number, peek: boolean, signal?: AbortSignal): Promise<Received> {
    for (;;) {
      const pending = this.takeError();
      if (pending) throw new KernelError(pending);
      if (this.closed) throw new KernelError('EBADF');
      const next = this.queue[0];
      if (next) {
        if (!peek) {
          this.queue.shift();
          this.queued -= next.bytes.length;
          this.changes.wake();
        }
        const size = Math.max(0, max);
        return {
          bytes: next.bytes.slice(0, size),
          from: next.from,
          truncated: next.bytes.length > size,
        };
      }
      await this.changes.wait(signal);
    }
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.receive(max, false, signal)).bytes;
  }

  async peek(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.receive(max, true, signal)).bytes;
  }

  write(bytes: Uint8Array): Promise<number> {
    return this.send(bytes);
  }

  poll(): PollState {
    return {
      readable: this.queue.length > 0 || this.pending !== undefined || this.closed,
      writable: this.sending < DGRAM_SEND_ROOM,
      hangup: this.closed,
      ...(this.pending !== undefined ? { error: true } : {}),
    };
  }

  changed(signal?: AbortSignal): Promise<void> {
    return this.changes.wait(signal);
  }

  shutdown(how: number): void {
    if (!this.peer) throw new KernelError('ENOTCONN');
    if (how < 0 || how > 2) throw new KernelError('EINVAL');
  }

  getOption(level: number, name: number): number {
    if (level === SOL_SOCKET) {
      switch (name) {
        case SO_TYPE:
          return SOCK_DGRAM;
        case SO_ERROR: {
          const pending = this.takeError();
          return pending ? wasiErrno(pending) : 0;
        }
        case SO_DOMAIN:
          return AF_INET;
        case SO_BROADCAST:
          return 0;
        case SO_SNDBUF:
          return this.options.get(`${level}:${name}`) ?? DGRAM_SEND_ROOM;
        case SO_RCVBUF:
          return this.options.get(`${level}:${name}`) ?? DGRAM_QUEUE_BYTES;
      }
    }
    if (level === IPPROTO_IP && name >= IP_MULTICAST_FIRST && name <= IP_MULTICAST_LAST) {
      throw new KernelError('ENOPROTOOPT');
    }
    return this.options.get(`${level}:${name}`) ?? 0;
  }

  setOption(level: number, name: number, value: number): void {
    if (level === SOL_SOCKET && name === SO_BROADCAST && value !== 0) {
      throw new KernelError('EOPNOTSUPP');
    }
    if (level === IPPROTO_IP && name >= IP_MULTICAST_FIRST && name <= IP_MULTICAST_LAST) {
      throw new KernelError('ENOPROTOOPT');
    }
    this.options.set(`${level}:${name}`, value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop.abort();
    for (const opening of this.uplinks.values()) {
      opening.then(
        (socket) => socket.close(),
        () => undefined
      );
    }
    this.uplinks.clear();
    if (this.local) this.net.releaseDgram(this.local, this);
    this.queue.length = 0;
    this.queued = 0;
    this.changes.wake();
  }
}
