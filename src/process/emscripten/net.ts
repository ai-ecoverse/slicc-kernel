import { normalizePath } from '../../fs/types.ts';
import { SIG } from '../../kernel/signals.ts';
import type { SockAddr } from '../../kernel/socket.ts';
import { WasiExit } from '../wasi/wasi-host.ts';
import type { EmContext } from './context.ts';
import { EM, EmError, errnoOf } from './errno.ts';

const KILLED_BY_SIGPIPE = 128 + SIG.PIPE;

function guard(ctx: EmContext, op: () => number): number {
  for (;;) {
    try {
      return op();
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === undefined) throw e;
      if (errno === 27 && ctx.gate.restartable()) continue;
      return -errno;
    }
  }
}

function socketFd(ctx: EmContext, fd: number): { nonblock: boolean } {
  const e = ctx.host.fds.get(fd);
  if (e.type !== 'kernel' || ctx.host.fds.kind(fd, e) !== 'socket') throw new EmError(EM.NOTSOCK);
  return e;
}

function resolved(ctx: EmContext, addr: SockAddr): SockAddr {
  if (addr.family !== 'unix' || !addr.path || addr.path.startsWith('\0')) return addr;
  const path = addr.path.startsWith('/') ? addr.path : `${ctx.cwd.path}/${addr.path}`;
  return { family: 'unix', path: normalizePath(path) };
}

function install(ctx: EmContext, fd: number, nonblock: boolean, cloexec: boolean): number {
  ctx.host.fds.adopt(fd, 'socket', nonblock);
  if (nonblock) ctx.host.fds.setFlags(fd, true, false);
  if (cloexec) ctx.host.fds.setCloexec(fd, true);
  return fd;
}

function writeAddr(ctx: EmContext, out: number, a: SockAddr | undefined): void {
  if (!a) return;
  const v = ctx.mem.view();
  if (a.family === 'unix') {
    v.setInt32(out, 1, true);
    const bytes = new TextEncoder().encode(a.path).subarray(0, 107);
    ctx.mem.bytes(out + 12, bytes.length + 1).set(bytes);
    ctx.mem.bytes(out + 12 + bytes.length, 1)[0] = 0;
    return;
  }
  const q = a.host.split('.');
  const ip =
    ((Number(q[0]) << 24) | (Number(q[1]) << 16) | (Number(q[2]) << 8) | Number(q[3])) >>> 0;
  v.setInt32(out, 2, true);
  v.setUint32(out + 4, ip, true);
  v.setInt32(out + 8, a.port, true);
}

export function netImports(ctx: EmContext): Record<string, unknown> {
  const { mem } = ctx;
  const json = (req: Parameters<EmContext['call']>[0]) => ctx.call(req);
  return {
    slicc_net_ready: () => 1,
    slicc_socket_js: (unix: number, nonblock: number, cloexec: number) =>
      guard(ctx, () => {
        const fd = json({ op: 'sock-open', domain: unix ? 'unix' : 'inet' }) as number;
        return install(ctx, fd, !!nonblock, !!cloexec);
      }),
    slicc_bind_js: (
      fd: number,
      family: number,
      ip: number,
      port: number,
      path: number,
      connect: number
    ) =>
      guard(ctx, () => {
        const host = [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
        const given: SockAddr =
          family === 1
            ? { family: 'unix', path: mem.cString(path) }
            : { family: 'inet', host, port };
        const e = socketFd(ctx, fd);
        const addr = resolved(ctx, given);
        if (connect) json({ op: 'sock-connect', fd, addr, nonblock: e.nonblock });
        else json({ op: 'sock-bind', fd, addr });
        return 0;
      }),
    slicc_listen_js: (fd: number, backlog: number) =>
      guard(ctx, () => {
        socketFd(ctx, fd);
        json({ op: 'sock-listen', fd, backlog });
        return 0;
      }),
    slicc_addr_call_js: (op: number, fd: number, arg: number, out: number) =>
      guard(ctx, () => {
        const e = socketFd(ctx, fd);
        if (op === 0) {
          const got = json({ op: 'sock-accept', fd, nonblock: e.nonblock }) as {
            fd: number;
            peer: SockAddr;
          };
          const at = install(ctx, got.fd, (arg & 1) !== 0, (arg & 2) !== 0);
          writeAddr(ctx, out, got.peer);
          return at;
        }
        writeAddr(ctx, out, json({ op: 'sock-name', fd, peer: op === 2 }) as SockAddr);
        return 0;
      }),
    slicc_shutdown_js: (fd: number, how: number) =>
      guard(ctx, () => {
        socketFd(ctx, fd);
        json({ op: 'sock-shutdown', fd, how });
        return 0;
      }),
    slicc_getopt_js: (fd: number, level: number, name: number, value: number) =>
      guard(ctx, () => {
        socketFd(ctx, fd);
        const got = json({ op: 'sock-getopt', fd, level, name }) as number;
        mem.view().setInt32(value, got, true);
        return 0;
      }),
    slicc_setopt_js: (fd: number, level: number, name: number, value: number) =>
      guard(ctx, () => {
        socketFd(ctx, fd);
        json({ op: 'sock-setopt', fd, level, name, value });
        return 0;
      }),
    slicc_send_js: (fd: number, buf: number, len: number, dontwait: number, nosignal: number) =>
      guard(ctx, () => {
        const e = socketFd(ctx, fd);
        const bytes = mem.bytes(buf, len).slice();
        try {
          return ctx.sys.write(fd, bytes, { nonblock: !!dontwait || e.nonblock });
        } catch (err) {
          const broken = (err as { code?: unknown }).code === 'EPIPE';
          if (broken && !nosignal && !sigpipeSpared(ctx)) throw new WasiExit(KILLED_BY_SIGPIPE);
          throw err;
        }
      }),
    slicc_recv_js: (fd: number, buf: number, len: number, dontwait: number, peek: number) =>
      guard(ctx, () => {
        const e = socketFd(ctx, fd);
        const got = ctx.sys.read(fd, len, { nonblock: !!dontwait || e.nonblock, peek: !!peek });
        mem.bytes(buf, got.length).set(got);
        return got.length;
      }),
    slicc_resolve_js: (name: number, out: number, max: number) => {
      let r: string[];
      try {
        r = json({ op: 'sock-resolve', name: mem.cString(name), family: 4 }) as string[];
      } catch (e) {
        const errno = errnoOf(e);
        if (errno === undefined) throw e;
        return -errno;
      }
      if (!Array.isArray(r)) return -EM.NOSYS;
      let n = 0;
      for (const a of r) {
        const parts = String(a).split('.');
        if (parts.length !== 4 || n >= max) continue;
        let ok = true;
        let ip = 0;
        for (let i = 0; i < 4; i++) {
          const x = Number(parts[i]);
          if (String(x) !== parts[i] || x > 255) ok = false;
          ip = (ip << 8) | (x & 255);
        }
        if (!ok) continue;
        mem.view().setUint32(out + 4 * n++, ip >>> 0, true);
      }
      return n;
    },
  };
}

export function sigpipeSpared(ctx: EmContext): boolean {
  const spare = ctx.exports().slicc_sigpipe;
  if (typeof spare === 'function' && ctx.enter('slicc_sigpipe', spare as () => number, []) === 1) {
    return true;
  }
  try {
    const r = ctx.call({ op: 'proc-kill-self', sig: SIG.PIPE, probe: true });
    return r !== 'terminate';
  } catch {
    return false;
  }
}
