import { DGRAM_QUEUE_BYTES, DGRAM_QUEUE_COUNT, KernelDgram } from './dgram.ts';
import { KernelError, type KernelFile, type PollState } from './fd-table.ts';
import { Changes, type LoopbackNet, type PeerCred, type SockAddr } from './socket.ts';

export type UnixAddr = Extract<SockAddr, { family: 'unix' }>;

export interface UnixDatagram {
  bytes: Uint8Array;
  from: UnixAddr;
  sender: UnixDgram;
}

export interface UnixReceived {
  bytes: Uint8Array;
  from: UnixAddr;
  truncated: boolean;
}

const SOL_SOCKET = 1;
const SO_TYPE = 3;
const SO_ERROR = 4;
const SO_SNDBUF = 7;
const SO_RCVBUF = 8;
const SO_DOMAIN = 39;
const SOCK_DGRAM = 2;
const AF_UNIX = 1;
const UNNAMED: UnixAddr = { family: 'unix', path: '' };

export class UnixDgram implements KernelFile {
  local: UnixAddr | undefined;
  peer: UnixAddr | undefined;
  key: string | undefined;
  peerCred: PeerCred | undefined;
  private target: UnixDgram | undefined;
  private readonly net: LoopbackNet;
  private readonly queue: UnixDatagram[] = [];
  private queued = 0;
  private closed = false;
  private readonly changes = new Changes();
  private readonly options = new Map<string, number>();

  constructor(net: LoopbackNet) {
    this.net = net;
  }

  static pair(net: LoopbackNet, cred?: PeerCred): [UnixDgram, UnixDgram] {
    const a = new UnixDgram(net);
    const b = new UnixDgram(net);
    a.target = b;
    b.target = a;
    a.peer = b.peer = UNNAMED;
    a.peerCred = b.peerCred = cred;
    return [a, b];
  }

  bind(addr: SockAddr, key: string): void {
    if (addr.family !== 'unix') throw new KernelError('EINVAL');
    if (this.local) throw new KernelError('EINVAL');
    if (addr.path === '') throw new KernelError('EINVAL');
    this.net.bindUnixDgram(this, key);
    this.local = { family: 'unix', path: addr.path };
    this.key = key;
  }

  connectTo(addr: UnixAddr, target: UnixDgram): void {
    this.target = target;
    this.peer = addr;
    const kept = this.queue.filter((d) => d.sender === target);
    this.queue.splice(0, this.queue.length, ...kept);
    this.queued = kept.reduce((sum, d) => sum + d.bytes.length, 0);
  }

  destination(): UnixDgram {
    if (!this.target) throw new KernelError('EDESTADDRREQ');
    return this.target;
  }

  room(bytes: number): boolean {
    return (
      this.closed ||
      (this.queue.length < DGRAM_QUEUE_COUNT && this.queued + bytes <= DGRAM_QUEUE_BYTES)
    );
  }

  async send(
    bytes: Uint8Array,
    to: UnixDgram,
    nonblock: boolean,
    signal?: AbortSignal
  ): Promise<number> {
    if (this.closed) throw new KernelError('EBADF');
    if (bytes.length > DGRAM_QUEUE_BYTES) throw new KernelError('EMSGSIZE');
    if (to.target && to.target !== this) throw new KernelError('EPERM');
    while (!to.room(bytes.length)) {
      if (nonblock) throw new KernelError('EAGAIN');
      await to.changed(signal);
    }
    if (to.closed) throw new KernelError('ECONNREFUSED');
    to.queue.push({ bytes: bytes.slice(), from: this.local ?? UNNAMED, sender: this });
    to.queued += bytes.length;
    to.changes.wake();
    return bytes.length;
  }

  async receive(max: number, peek: boolean, signal?: AbortSignal): Promise<UnixReceived> {
    for (;;) {
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

  write(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    return this.send(bytes, this.destination(), false, signal);
  }

  poll(): PollState {
    const target = this.target;
    return {
      readable: this.queue.length > 0 || this.closed,
      writable: !target || target.room(1),
      hangup: this.closed,
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
        case SO_ERROR:
          return 0;
        case SO_DOMAIN:
          return AF_UNIX;
        case SO_SNDBUF:
        case SO_RCVBUF:
          return this.options.get(`${level}:${name}`) ?? DGRAM_QUEUE_BYTES;
      }
    }
    return this.options.get(`${level}:${name}`) ?? 0;
  }

  setOption(level: number, name: number, value: number): void {
    this.options.set(`${level}:${name}`, value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.key !== undefined) this.net.releaseUnixDgram(this.key, this);
    this.queue.length = 0;
    this.queued = 0;
    this.changes.wake();
  }
}

export function isDatagram(file: KernelFile): file is KernelDgram | UnixDgram {
  return file instanceof KernelDgram || file instanceof UnixDgram;
}
