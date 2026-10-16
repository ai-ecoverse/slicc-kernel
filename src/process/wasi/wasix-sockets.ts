import { decodeReceived } from '../../kernel/net/datagram-wire.ts';
import { ipv6Groups } from '../../kernel/net/routes.ts';
import type { SockAddr } from '../../kernel/socket.ts';
import { E, FDFLAGS } from './wasi-abi.ts';
import { WasiError } from './wasi-files.ts';
import type { WasiFunction, WasiHost } from './wasi-host.ts';

const INET4 = 1;
const INET6 = 2;
const UNIX = 3;
const STREAM = 1;
const DGRAM = 2;
const RECV_DATA_TRUNCATED = 1;
const RIFLAG_PEEK = 1;
const MAX_DATAGRAM = 65_536;
const ADDR_IP_SIZE = 18;
const LOOPBACK = '127.0.0.1';

const OPTIONS: Readonly<Record<number, readonly [number, number]>> = {
  1: [1, 15],
  2: [1, 2],
  3: [6, 1],
  4: [1, 5],
  6: [1, 6],
  10: [1, 30],
  11: [1, 4],
  12: [1, 9],
  14: [1, 10],
  15: [1, 8],
  16: [1, 7],
  25: [1, 3],
};

export function readAddr(view: DataView, ptr: number): SockAddr {
  const tag = view.getUint8(ptr);
  if (tag === UNIX) {
    let end = ptr + 2;
    while (end < ptr + 110 && view.getUint8(end) !== 0) end++;
    const path = new TextDecoder().decode(
      new Uint8Array(view.buffer, ptr + 2, end - ptr - 2).slice()
    );
    return { family: 'unix', path };
  }
  const port = view.getUint16(ptr + 2, true);
  if (tag === INET4) {
    const host = [0, 1, 2, 3].map((i) => view.getUint8(ptr + 4 + i)).join('.');
    return { family: 'inet', host, port };
  }
  if (tag === INET6) {
    return { family: 'inet', host: ipv6Host(new Uint8Array(view.buffer, ptr + 4, 16)), port };
  }
  throw new WasiError('EAFNOSUPPORT');
}

function ipv6Host(bytes: Uint8Array): string {
  const zeros = (n: number) => bytes.subarray(0, n).every((b) => b === 0);
  if (zeros(16)) return '0.0.0.0';
  if (zeros(15) && bytes[15] === 1) return LOOPBACK;
  if (zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.subarray(12).join('.');
  const groups = [0, 2, 4, 6, 8, 10, 12, 14].map((i) =>
    ((bytes[i] << 8) | bytes[i + 1]).toString(16)
  );
  return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
}

export function writeAddr(view: DataView, ptr: number, addr: SockAddr | undefined): void {
  new Uint8Array(view.buffer, ptr, 110).fill(0);
  if (!addr) return;
  if (addr.family === 'unix') {
    view.setUint8(ptr, UNIX);
    new Uint8Array(view.buffer, ptr + 2, 107).set(
      new TextEncoder().encode(addr.path).subarray(0, 107)
    );
    return;
  }
  view.setUint16(ptr + 2, addr.port, true);
  const groups = ipv4(addr.host) ? undefined : ipv6Groups(addr.host);
  if (groups) {
    view.setUint8(ptr, INET6);
    groups.forEach((g, i) => void view.setUint16(ptr + 4 + i * 2, g));
    return;
  }
  view.setUint8(ptr, INET4);
  const octets = ipv4(addr.host) ?? [127, 0, 0, 1];
  octets.forEach((b, i) => void view.setUint8(ptr + 4 + i, b));
}

function ipBytes(host: string): number[] | undefined {
  const groups = ipv4(host) ? undefined : ipv6Groups(host);
  return groups ? groups.flatMap((g) => [g >> 8, g & 0xff]) : ipv4(host);
}

function ipv4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : undefined;
}

function openRequest(af: number, type: number) {
  if (af !== INET4 && af !== INET6 && af !== UNIX) throw new WasiError('EAFNOSUPPORT');
  if (type !== STREAM && type !== DGRAM) throw new WasiError('EPROTONOSUPPORT');
  const domain = af === UNIX ? ('unix' as const) : ('inet' as const);
  return {
    op: 'sock-open' as const,
    domain,
    ...(type === DGRAM ? { type: 'dgram' as const } : {}),
  };
}

function pairRequest(af: number, type: number) {
  if (af !== UNIX)
    throw new WasiError(af === INET4 || af === INET6 ? 'EOPNOTSUPP' : 'EAFNOSUPPORT');
  if (type !== STREAM && type !== DGRAM) throw new WasiError('EPROTONOSUPPORT');
  return {
    op: 'sock-pair' as const,
    domain: 'unix' as const,
    ...(type === DGRAM ? { type: 'dgram' as const } : {}),
  };
}

function absolute(cwd: string, addr: SockAddr): SockAddr {
  if (addr.family !== 'unix' || addr.path === '' || addr.path.startsWith('\0')) return addr;
  return addr.path.startsWith('/') ? addr : { family: 'unix', path: `${cwd}/${addr.path}` };
}

function optionalAddr(view: DataView, ptr: number): SockAddr | undefined {
  if (ptr === 0 || view.getUint8(ptr) === 0) return undefined;
  return readAddr(view, ptr);
}

export function datagramCalls(host: WasiHost) {
  const { mem, o } = host;
  const call = (req: Parameters<typeof o.kernel.call>[0]) => o.kernel.call(req);
  return {
    recvFrom(
      fd: number,
      nonblock: boolean,
      iovs: number,
      n: number,
      riflags: number,
      outLen: number,
      outFlags: number,
      outAddr: number
    ): number {
      const max = Math.min(mem.capacity(iovs, n), MAX_DATAGRAM);
      const peek = (riflags & RIFLAG_PEEK) !== 0;
      const raw = call({ op: 'sock-recvfrom', fd, max, peek, nonblock });
      const got = decodeReceived(raw as Uint8Array);
      const view = mem.view();
      view.setUint32(outLen, mem.scatter(iovs, n, got.bytes), true);
      view.setUint16(outFlags, got.truncated ? RECV_DATA_TRUNCATED : 0, true);
      const from: SockAddr = got.unix
        ? { family: 'unix', path: got.host }
        : { family: 'inet', host: got.host, port: got.port };
      if (outAddr) writeAddr(mem.view(), outAddr, from);
      return E.SUCCESS;
    },
    sendTo(fd: number, nonblock: boolean, iovs: number, n: number, addr: number, out: number) {
      const named = optionalAddr(mem.view(), addr);
      const to = named && absolute(host.cwd, named);
      const body = mem.gather(iovs, n);
      const sent = call({ op: 'sock-sendto', fd, body, ...(to ? { addr: to } : {}), nonblock });
      mem.view().setUint32(out, sent as number, true);
      return E.SUCCESS;
    },
  };
}

export function wasixSocketImports(
  host: WasiHost,
  preview1: Record<string, WasiFunction>
): Record<string, WasiFunction> {
  const { mem, fds, o } = host;
  const call = (req: Parameters<typeof o.kernel.call>[0]) => o.kernel.call(req);

  const socket = (fd: number) => {
    const e = fds.get(fd);
    if (e.type !== 'kernel' || fds.kind(fd, e) !== 'socket') throw new WasiError('ENOTSOCK');
    return e;
  };
  const option = (opt: number): readonly [number, number] | undefined => OPTIONS[opt];
  const datagrams = (fd: number): boolean => {
    try {
      const e = fds.get(fd);
      return e.type === 'kernel' && fds.datagram(fd, e);
    } catch {
      return false;
    }
  };
  const dgram = datagramCalls(host);
  return {
    sock_open: (af: number, type: number, _proto: number, out: number) => {
      const req = openRequest(af, type);
      const fd = call(req) as number;
      fds.adopt(fd, 'socket', false, 'type' in req);
      mem.view().setUint32(out, fd, true);
    },
    sock_pair: (af: number, type: number, _proto: number, out1: number, out2: number) => {
      const req = pairRequest(af, type);
      mem.view().setUint32(out1, 0, true);
      mem.view().setUint32(out2, 0, true);
      const [a, b] = call(req) as [number, number];
      fds.adopt(a, 'socket', false, 'type' in req);
      fds.adopt(b, 'socket', false, 'type' in req);
      mem.view().setUint32(out1, a, true);
      mem.view().setUint32(out2, b, true);
    },
    sock_bind: (fd: number, addr: number) => {
      socket(fd);
      call({ op: 'sock-bind', fd, addr: absolute(host.cwd, readAddr(mem.view(), addr)) });
    },
    sock_listen: (fd: number, backlog: number) => {
      socket(fd);
      call({ op: 'sock-listen', fd, backlog });
    },
    sock_connect: (fd: number, addr: number) => {
      const e = socket(fd);
      const to = absolute(host.cwd, readAddr(mem.view(), addr));
      call({ op: 'sock-connect', fd, addr: to, nonblock: e.nonblock });
    },
    sock_accept_v2: (fd: number, flags: number, outFd: number, outAddr: number) => {
      const e = socket(fd);
      const r = call({ op: 'sock-accept', fd, nonblock: e.nonblock }) as {
        fd: number;
        peer?: SockAddr;
      };
      fds.adopt(r.fd, 'socket', (flags & FDFLAGS.NONBLOCK) !== 0);
      mem.view().setUint32(outFd, r.fd, true);
      writeAddr(mem.view(), outAddr, r.peer);
    },
    sock_addr_local: (fd: number, out: number) => {
      socket(fd);
      writeAddr(mem.view(), out, call({ op: 'sock-name', fd, peer: false }) as SockAddr);
    },
    sock_addr_peer: (fd: number, out: number) => {
      socket(fd);
      writeAddr(mem.view(), out, call({ op: 'sock-name', fd, peer: true }) as SockAddr);
    },

    sock_recv_from: (
      fd: number,
      iovs: number,
      n: number,
      riflags: number,
      outLen: number,
      outFlags: number,
      outAddr: number
    ) => {
      if (datagrams(fd)) {
        const e = socket(fd);
        return dgram.recvFrom(fd, e.nonblock, iovs, n, riflags, outLen, outFlags, outAddr);
      }
      const r = preview1.sock_recv(
        fd as never,
        iovs as never,
        n as never,
        riflags as never,
        outLen as never,
        outFlags as never
      );
      if (r !== E.SUCCESS) return r;
      writeAddr(mem.view(), outAddr, call({ op: 'sock-name', fd, peer: true }) as SockAddr);
      return E.SUCCESS;
    },
    sock_send_to: (
      fd: number,
      iovs: number,
      n: number,
      flags: number,
      addr: number,
      out: number
    ) => {
      if (datagrams(fd)) return dgram.sendTo(fd, socket(fd).nonblock, iovs, n, addr, out);
      return preview1.sock_send(
        fd as never,
        iovs as never,
        n as never,
        flags as never,
        out as never
      );
    },
    sock_status: (fd: number, out: number) => {
      socket(fd);
      mem.view().setUint8(out, 1);
    },
    sock_get_opt_flag: (fd: number, opt: number, out: number) => {
      socket(fd);
      const pair = option(opt);
      const v = pair
        ? (call({ op: 'sock-getopt', fd, level: pair[0], name: pair[1] }) as number)
        : 0;
      mem.view().setUint8(out, v ? 1 : 0);
    },
    sock_set_opt_flag: (fd: number, opt: number, flag: number) => {
      socket(fd);
      const pair = option(opt);
      if (pair) call({ op: 'sock-setopt', fd, level: pair[0], name: pair[1], value: flag ? 1 : 0 });
    },
    sock_get_opt_size: (fd: number, opt: number, out: number) => {
      socket(fd);
      const pair = option(opt);
      const v = pair
        ? (call({ op: 'sock-getopt', fd, level: pair[0], name: pair[1] }) as number)
        : 0;
      mem.view().setBigUint64(out, BigInt(v), true);
    },
    sock_set_opt_size: (fd: number, opt: number, size: bigint) => {
      socket(fd);
      const pair = option(opt);
      if (pair) call({ op: 'sock-setopt', fd, level: pair[0], name: pair[1], value: Number(size) });
    },

    sock_get_opt_time: (fd: number, _opt: number, out: number) => {
      socket(fd);
      new Uint8Array(mem.view().buffer, out, 16).fill(0);
    },
    sock_set_opt_time: (fd: number) => void socket(fd),

    sock_send_file: () => E.NOSYS,

    resolve: (
      name: number,
      len: number,
      _port: number,
      addrs: number,
      naddrs: number,
      out: number
    ) => {
      const found = call({ op: 'sock-resolve', name: mem.string(name, len), family: 0 });
      const ips = (found as string[]).map(ipBytes).filter((ip) => ip !== undefined);
      if (ips.length === 0) throw new WasiError('ENOENT');
      if (naddrs < 1) throw new WasiError('EINVAL');
      const view = mem.view();
      const count = Math.min(ips.length, naddrs);
      new Uint8Array(view.buffer, addrs, ADDR_IP_SIZE * count).fill(0);
      for (let i = 0; i < count; i++) {
        const at = addrs + i * ADDR_IP_SIZE;
        view.setUint8(at, ips[i].length === 4 ? INET4 : INET6);
        new Uint8Array(view.buffer, at + 2, ips[i].length).set(ips[i]);
      }
      view.setUint32(out, count, true);
    },
  };
}
