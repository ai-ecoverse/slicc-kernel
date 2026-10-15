import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import { KernelDgram } from './dgram.ts';
import { type FdTable, KernelError, OpenFile, pollFile } from './fd-table.ts';
import { encodeReceived } from './net/datagram-wire.ts';
import type { ResolveFamily } from './net/uplink.ts';
import {
  type ConnectorStamp,
  KernelSocket,
  type LoopbackNet,
  type PeerCred,
  type SockAddr,
  type SocketDomain,
} from './socket.ts';
export type SocketSyscall =
  | {
      op: 'sock-open';
      domain: SocketDomain;
      type?: 'stream' | 'dgram';
    }
  | {
      op: 'sock-pair';
      domain: SocketDomain;
    }
  | {
      op: 'sock-bind';
      fd: number;
      addr: SockAddr;
    }
  | {
      op: 'sock-listen';
      fd: number;
      backlog: number;
    }
  | {
      op: 'sock-accept';
      fd: number;
      nonblock: boolean;
    }
  | {
      op: 'sock-connect';
      fd: number;
      addr: SockAddr;
      nonblock: boolean;
    }
  | {
      op: 'sock-shutdown';
      fd: number;
      how: number;
    }
  | {
      op: 'sock-name';
      fd: number;
      peer: boolean;
    }
  | {
      op: 'sock-getopt';
      fd: number;
      level: number;
      name: number;
    }
  | {
      op: 'sock-setopt';
      fd: number;
      level: number;
      name: number;
      value: number;
    }
  | {
      op: 'sock-resolve';
      name: string;
      family: ResolveFamily;
    }
  | {
      op: 'sock-sendto';
      fd: number;
      body: Uint8Array;
      addr?: SockAddr;
      nonblock: boolean;
    }
  | {
      op: 'sock-recvfrom';
      fd: number;
      max: number;
      peek: boolean;
      nonblock: boolean;
    };
export const SOCKET_OPS: readonly SocketSyscall['op'][] = [
  'sock-open',
  'sock-pair',
  'sock-bind',
  'sock-listen',
  'sock-accept',
  'sock-connect',
  'sock-shutdown',
  'sock-name',
  'sock-getopt',
  'sock-setopt',
  'sock-resolve',
  'sock-sendto',
  'sock-recvfrom',
];
export interface SocketProcess {
  fds: FdTable;
  net: LoopbackNet;
  blocking(): AbortSignal;
  resolve(name: string, family: ResolveFamily, blocking: () => AbortSignal): Promise<string[]>;
  cred?(): PeerCred;
  stamp?(): Promise<ConnectorStamp>;
}
function socketAt(fds: FdTable, fd: number): KernelSocket {
  const file = anySocketAt(fds, fd);
  if (file instanceof KernelDgram) throw new KernelError('EOPNOTSUPP');
  return file;
}
function anySocketAt(fds: FdTable, fd: number): KernelSocket | KernelDgram {
  const file = fds.get(fd).file;
  if (!(file instanceof KernelSocket) && !(file instanceof KernelDgram)) {
    throw new KernelError('ENOTSOCK');
  }
  return file;
}
function dgramAt(fds: FdTable, fd: number): KernelDgram {
  const file = anySocketAt(fds, fd);
  if (!(file instanceof KernelDgram)) throw new KernelError('EOPNOTSUPP');
  return file;
}
const ok = (json?: unknown): SyncFsResult =>
  json === undefined ? { ok: true, kind: 'void' } : { ok: true, kind: 'json', json };
export async function socketSyscall(
  req: SocketSyscall,
  proc: SocketProcess
): Promise<SyncFsResult> {
  const { fds, net } = proc;
  switch (req.op) {
    case 'sock-open': {
      if (req.type === 'dgram' && req.domain !== 'inet') throw new KernelError('EPROTONOSUPPORT');
      const file = req.type === 'dgram' ? new KernelDgram(net) : net.socket(req.domain);
      return ok(fds.install(new OpenFile(file), 3));
    }
    case 'sock-pair': {
      const [a, b] = KernelSocket.pair(net, req.domain, proc.cred?.());
      const first = fds.install(new OpenFile(a), 3);
      try {
        return ok([first, fds.install(new OpenFile(b), 3)]);
      } catch (e) {
        await Promise.resolve(fds.close(first));
        throw e;
      }
    }
    case 'sock-bind':
      anySocketAt(fds, req.fd).bind(req.addr);
      return ok();
    case 'sock-listen':
      socketAt(fds, req.fd).listen(req.backlog, proc.cred?.());
      return ok();
    case 'sock-accept':
      return ok(await accept(proc, req.fd, req.nonblock));
    case 'sock-connect':
      return connect(req, proc);
    case 'sock-shutdown':
      anySocketAt(fds, req.fd).shutdown(req.how);
      return ok();
    case 'sock-name': {
      const socket = anySocketAt(fds, req.fd);
      const addr = req.peer ? socket.peer : socket.local;
      if (req.peer && !addr) throw new KernelError('ENOTCONN');
      return ok(addr ?? unnamed(socket instanceof KernelDgram ? 'inet' : socket.domain));
    }
    case 'sock-getopt':
      return ok(anySocketAt(fds, req.fd).getOption(req.level, req.name));
    case 'sock-setopt':
      anySocketAt(fds, req.fd).setOption(req.level, req.name, req.value);
      return ok();
    case 'sock-resolve': {
      const addresses = await proc.resolve(req.name, req.family, () => proc.blocking());
      if (addresses.length === 0) throw new KernelError('ENOENT');
      return ok(addresses);
    }
    default:
      return datagram(req, proc);
  }
}
async function connect(
  req: Extract<SocketSyscall, { op: 'sock-connect' }>,
  proc: SocketProcess
): Promise<SyncFsResult> {
  const target = anySocketAt(proc.fds, req.fd);
  if (target instanceof KernelDgram) {
    target.connectTo(req.addr);
    return ok();
  }
  const stamp = proc.net.facadeAt(req.addr) && (await proc.stamp?.());
  const dialing = target.connect(req.addr, true, proc.cred?.(), stamp || undefined);
  if (req.nonblock) {
    dialing?.catch(() => undefined);
    throw new KernelError('EINPROGRESS');
  }
  if (dialing !== undefined) await interruptible(dialing, proc.blocking());
  return ok();
}
async function datagram(
  req: Extract<SocketSyscall, { op: 'sock-sendto' | 'sock-recvfrom' }>,
  proc: SocketProcess
): Promise<SyncFsResult> {
  const dgram = dgramAt(proc.fds, req.fd);
  if (req.op === 'sock-sendto') {
    if (req.nonblock && !pollFile(dgram).writable) throw new KernelError('EAGAIN');
    return ok(await dgram.send(req.body, req.addr));
  }
  const ready = pollFile(dgram).readable;
  if (req.nonblock && !ready) throw new KernelError('EAGAIN');
  const got = await dgram.receive(req.max, req.peek, ready ? undefined : proc.blocking());
  const { bytes, from, truncated } = got;
  return { ok: true, kind: 'bytes', bytes: encodeReceived({ bytes, truncated, ...from }) };
}
function interruptible(dialing: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new KernelError('EINTR'));
    signal.addEventListener('abort', abort, { once: true });
    dialing.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function unnamed(domain: SocketDomain): SockAddr {
  return domain === 'inet'
    ? { family: 'inet', host: '0.0.0.0', port: 0 }
    : { family: 'unix', path: '' };
}
async function accept(
  proc: SocketProcess,
  fd: number,
  nonblock: boolean
): Promise<{
  fd: number;
  peer: SockAddr | undefined;
}> {
  const listener = socketAt(proc.fds, fd);
  const waits = !nonblock && !pollFile(listener).readable;
  const socket = await listener.accept(waits ? proc.blocking() : undefined, nonblock);
  return { fd: proc.fds.install(new OpenFile(socket), 3), peer: socket.peer };
}
