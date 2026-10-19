import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import { KernelDgram } from './dgram.ts';
import { type FdTable, KernelError, OpenFile, pollFile } from './fd-table.ts';
import { encodeReceived } from './net/datagram-wire.ts';
import { isLoopbackHost } from './net/proxy-service.ts';
import {
  type ClientCertRequest,
  connectSecure,
  upgradeSecure,
  uplinkAddress,
} from './net/tls-uplink.ts';
import type { ResolveFamily } from './net/uplink.ts';
import type { SealedBroker } from './sealed.ts';
import {
  type ConnectorStamp,
  KernelSocket,
  keyOf,
  type LoopbackNet,
  type PeerCred,
  type SockAddr,
  type SocketDomain,
} from './socket.ts';
import { filePath, type SocketNames } from './socket-nodes.ts';
import { type UnixAddr, UnixDgram } from './unix-dgram.ts';
export type SocketSyscall =
  | {
      op: 'sock-open';
      domain: SocketDomain;
      type?: 'stream' | 'dgram';
    }
  | {
      op: 'sock-pair';
      domain: SocketDomain;
      type?: 'stream' | 'dgram';
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
      op: 'sock-tls';
      host: string;
      port: number;
      servername?: string;
      alpn?: string[];
      ca?: true | string[];
      insecure?: boolean;
      sni?: false;
      checkHostname?: false;
      clientCert?: ClientCertRequest;
      path?: 'kernel' | 'transport';
    }
  | {
      op: 'sock-tls-upgrade';
      fd: number;
      servername?: string;
      alpn?: string[];
      ca?: true | string[];
      insecure?: boolean;
      sni?: false;
      checkHostname?: false;
      clientCert?: ClientCertRequest;
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
  'sock-tls',
  'sock-tls-upgrade',
];
export interface SocketProcess {
  fds: FdTable;
  net: LoopbackNet;
  blocking(): AbortSignal;
  resolve(name: string, family: ResolveFamily, blocking: () => AbortSignal): Promise<string[]>;
  cred?(): PeerCred;
  stamp?(): Promise<ConnectorStamp>;
  names?: SocketNames;
  sealed?: SealedBroker | undefined;
}
function socketAt(fds: FdTable, fd: number): KernelSocket {
  const file = anySocketAt(fds, fd);
  if (!(file instanceof KernelSocket)) throw new KernelError('EOPNOTSUPP');
  return file;
}
function anySocketAt(fds: FdTable, fd: number): KernelSocket | KernelDgram | UnixDgram {
  const file = fds.get(fd).file;
  if (
    !(file instanceof KernelSocket) &&
    !(file instanceof KernelDgram) &&
    !(file instanceof UnixDgram)
  ) {
    throw new KernelError('ENOTSOCK');
  }
  return file;
}
function dgramAt(fds: FdTable, fd: number): KernelDgram | UnixDgram {
  const file = anySocketAt(fds, fd);
  if (file instanceof KernelSocket) throw new KernelError('EOPNOTSUPP');
  return file;
}
async function unixTarget(proc: SocketProcess, addr: SockAddr): Promise<UnixDgram> {
  if (addr.family !== 'unix') throw new KernelError('EAFNOSUPPORT');
  const path = filePath(addr);
  const name = path !== undefined ? await proc.names?.find(path) : undefined;
  return proc.net.unixDgramAt(keyOf(path !== undefined ? { family: 'unix', path } : addr, name));
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
      const file =
        req.type !== 'dgram'
          ? net.socket(req.domain)
          : req.domain === 'unix'
            ? new UnixDgram(net)
            : new KernelDgram(net);
      return ok(fds.install(new OpenFile(file), 3));
    }
    case 'sock-pair': {
      const [a, b] =
        req.type === 'dgram' && req.domain === 'unix'
          ? UnixDgram.pair(net, proc.cred?.())
          : KernelSocket.pair(net, req.domain, proc.cred?.());
      const first = fds.install(new OpenFile(a), 3);
      try {
        return ok([first, fds.install(new OpenFile(b), 3)]);
      } catch (e) {
        await Promise.resolve(fds.close(first));
        throw e;
      }
    }
    case 'sock-bind':
      await bind(proc, req.fd, req.addr);
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
      return ok(addr ?? unnamed(socket instanceof KernelSocket ? socket.domain : domainOf(socket)));
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
    case 'sock-tls':
      return ok(await secureConnect(req, proc));
    case 'sock-tls-upgrade':
      return ok(await upgradeSecure(proc, socketAt(fds, req.fd), req));
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
  if (target instanceof UnixDgram) {
    target.connectTo(req.addr as UnixAddr, await unixTarget(proc, req.addr));
    return ok();
  }
  const path = filePath(req.addr);
  const name = path !== undefined ? await proc.names?.find(path) : undefined;
  const stamp = proc.net.facadeAt(req.addr) && (await proc.stamp?.());
  const dialing = target.connect(req.addr, true, proc.cred?.(), stamp || undefined, true, name);
  if (req.nonblock) {
    dialing?.catch(() => undefined);
    throw new KernelError('EINPROGRESS');
  }
  if (dialing !== undefined) await interruptible(dialing, proc.blocking());
  return ok();
}
async function bindUnixDgram(
  proc: SocketProcess,
  socket: UnixDgram,
  addr: SockAddr
): Promise<void> {
  const path = filePath(addr);
  if (path === undefined || !proc.names) {
    socket.bind(addr, keyOf(addr));
    return;
  }
  const name = await proc.names.make(path);
  try {
    socket.bind({ family: 'unix', path }, keyOf({ family: 'unix', path }, name));
  } catch (err) {
    await name.remove();
    throw err;
  }
}
async function bind(proc: SocketProcess, fd: number, addr: SockAddr): Promise<void> {
  const socket = anySocketAt(proc.fds, fd);
  if (socket instanceof UnixDgram) return bindUnixDgram(proc, socket, addr);
  const path = filePath(addr);
  if (!(socket instanceof KernelSocket) || path === undefined || !proc.names) {
    socket.bind(addr);
    return;
  }
  socket.bindable(addr);
  const name = await proc.names.make(path);
  try {
    socket.bind({ family: 'unix', path }, false, name);
  } catch (err) {
    await name.remove();
    throw err;
  }
}
async function datagram(
  req: Extract<SocketSyscall, { op: 'sock-sendto' | 'sock-recvfrom' }>,
  proc: SocketProcess
): Promise<SyncFsResult> {
  const dgram = dgramAt(proc.fds, req.fd);
  if (dgram instanceof UnixDgram) return unixDatagram(req, dgram, proc);
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
async function unixDatagram(
  req: Extract<SocketSyscall, { op: 'sock-sendto' | 'sock-recvfrom' }>,
  dgram: UnixDgram,
  proc: SocketProcess
): Promise<SyncFsResult> {
  if (req.op === 'sock-sendto') {
    const to = req.addr ? await unixTarget(proc, req.addr) : dgram.destination();
    return ok(await dgram.send(req.body, to, req.nonblock, proc.blocking()));
  }
  const ready = pollFile(dgram).readable;
  if (req.nonblock && !ready) throw new KernelError('EAGAIN');
  const got = await dgram.receive(req.max, req.peek, ready ? undefined : proc.blocking());
  const { bytes, from, truncated } = got;
  return {
    ok: true,
    kind: 'bytes',
    bytes: encodeReceived({ bytes, truncated, host: from.path, port: 0, unix: true }),
  };
}
function domainOf(socket: KernelDgram | UnixDgram): SocketDomain {
  return socket instanceof UnixDgram ? 'unix' : 'inet';
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

const NOT_HTTP_PORTS = new Set([
  465, 563, 585, 636, 853, 989, 990, 992, 993, 994, 995, 5061, 5671, 6697, 8883,
]);
const HOST_NAME = /^[A-Za-z0-9.-]+$|^\[?[0-9A-Fa-f:.]+\]?$/;
function sessionControls(req: Extract<SocketSyscall, { op: 'sock-tls' }>): boolean {
  return req.sni === false || req.checkHostname === false || req.clientCert !== undefined;
}

function wantsKernel(req: Extract<SocketSyscall, { op: 'sock-tls' }>): boolean {
  if (req.path === 'kernel') return true;
  if (req.path === 'transport') return false;
  return (
    Array.isArray(req.ca) ||
    sessionControls(req) ||
    (req.alpn !== undefined && req.alpn.length > 0 && !req.alpn.includes('http/1.1')) ||
    NOT_HTTP_PORTS.has(req.port)
  );
}

async function secureConnect(
  req: Extract<SocketSyscall, { op: 'sock-tls' }>,
  proc: SocketProcess
): Promise<unknown> {
  if (!Number.isInteger(req.port) || req.port < 1 || req.port > 65535)
    throw new KernelError('EINVAL');
  const kernelPath = wantsKernel(req) && (await uplinked(proc, req.host));
  if (!kernelPath) {
    if (req.path === 'kernel' || Array.isArray(req.ca) || sessionControls(req)) {
      delete req.clientCert;
      throw new KernelError('ENOTSUP');
    }
    return { ...tlsOverTransport(req, proc), path: 'transport', substitutes: true };
  }
  const socket = proc.net.socket('inet');
  const fd = proc.fds.install(new OpenFile(socket), 3);
  try {
    return { fd, ...(await connectSecure(proc, socket, req.host, req.port, req)) };
  } catch (e) {
    await Promise.resolve(proc.fds.close(fd));
    throw e;
  }
}

async function uplinked(proc: SocketProcess, host: string): Promise<boolean> {
  if (!proc.net.tlsClient || isLoopbackHost(host)) return false;
  try {
    return proc.net.uplinkFor(await uplinkAddress(proc, host)) !== undefined;
  } catch {
    return false;
  }
}

function tlsOverTransport(
  req: Extract<SocketSyscall, { op: 'sock-tls' }>,
  proc: SocketProcess
): { fd: number; alpnProtocol: string; servername: string } {
  if (req.ca) throw new KernelError('ENOTSUP');
  if (req.alpn && req.alpn.length > 0 && !req.alpn.includes('http/1.1')) {
    throw new KernelError('EPROTONOSUPPORT');
  }
  if (!Number.isInteger(req.port) || req.port < 1 || req.port > 65535)
    throw new KernelError('EINVAL');
  if (NOT_HTTP_PORTS.has(req.port)) throw new KernelError('EPROTONOSUPPORT');
  const servername = req.servername || req.host;
  if (!HOST_NAME.test(servername)) throw new KernelError('EINVAL');
  if (isLoopbackHost(servername) || isLoopbackHost(req.host)) throw new KernelError('ENOTSUP');
  const host =
    servername.includes(':') && !servername.startsWith('[') ? `[${servername}]` : servername;
  const origin = req.port === 443 ? `https://${host}` : `https://${host}:${req.port}`;
  const [mine, theirs] = KernelSocket.pair(proc.net, 'inet', proc.cred?.());
  mine.peer = { family: 'inet', host: req.host, port: req.port };
  try {
    proc.net.serveOrigin(theirs, origin);
  } catch (err) {
    mine.close();
    theirs.close();
    throw err;
  }
  return { fd: proc.fds.install(new OpenFile(mine), 3), alpnProtocol: 'http/1.1', servername };
}
