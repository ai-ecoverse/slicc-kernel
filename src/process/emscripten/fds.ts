import type { Termios } from '../../kernel/tty.ts';
import { TIOCGPTN, TIOCPKT, TIOCSCTTY, TIOCSPTLCK, TIOCSWINSZ } from '../process-pty.ts';
import type { EmContext } from './context.ts';
import { EM, negated } from './errno.ts';
import { fdFlags, O_APPEND, O_CLOEXEC, O_NONBLOCK } from './files.ts';

const F_DUPFD = 0;
const F_GETFD = 1;
const F_SETFD = 2;
const F_GETFL = 3;
const F_SETFL = 4;
const F_GETLK = 12;
const F_SETLK = 13;
const F_SETLKW = 14;
const F_DUPFD_CLOEXEC = 1030;
const FD_CLOEXEC = 1;

const TCGETS = 21505;
const TCSETS = 21506;
const TCSETSW = 21507;
const TCSETSF = 21508;
const TCSBRK = 21509;
const TCXONC = 21510;
const TCFLSH = 21515;
const TIOCGPGRP = 21519;
const TIOCSPGRP = 21520;
const TIOCGWINSZ = 21523;
const FIONREAD = 21531;
const FIONBIO = 21537;

const POLLIN = 0x001;
const POLLOUT = 0x004;
const POLLERR = 0x008;
const POLLHUP = 0x010;
const POLLNVAL = 0x020;
const POLLRDNORM = 0x040;
const POLLWRNORM = 0x100;

function isTty(ctx: EmContext, fd: number): boolean {
  const e = ctx.host.fds.get(fd);
  return e.type === 'kernel' && ctx.host.fds.kind(fd, e) === 'tty';
}

function isKernel(ctx: EmContext, fd: number): boolean {
  return ctx.host.fds.find(fd)?.type === 'kernel';
}

function readTermios(ctx: EmContext, ptr: number): Termios {
  const v = ctx.mem.view();
  const cCc: number[] = [];
  for (let i = 0; i < 32; i++) cCc.push(v.getInt8(ptr + 17 + i));
  return {
    c_iflag: v.getInt32(ptr, true),
    c_oflag: v.getInt32(ptr + 4, true),
    c_cflag: v.getInt32(ptr + 8, true),
    c_lflag: v.getInt32(ptr + 12, true),
    c_cc: cCc,
  };
}

function writeTermios(ctx: EmContext, ptr: number, t: Termios): void {
  const v = ctx.mem.view();
  v.setInt32(ptr, t.c_iflag || 0, true);
  v.setInt32(ptr + 4, t.c_oflag || 0, true);
  v.setInt32(ptr + 8, t.c_cflag || 0, true);
  v.setInt32(ptr + 12, t.c_lflag || 0, true);
  for (let i = 0; i < 32; i++) v.setInt8(ptr + 17 + i, t.c_cc[i] || 0);
}

function ptyIoctl(ctx: EmContext, fd: number, request: number, argp: number): number {
  const v = ctx.mem.view();
  switch (request) {
    case TIOCGPTN:
      v.setInt32(argp, ctx.sys.ptyNumber(fd), true);
      return 0;
    case TIOCSPTLCK:
      ctx.sys.ptyLock(fd, v.getInt32(argp, true) !== 0);
      return 0;
    case TIOCSCTTY:
      ctx.sys.setControllingTerminal(fd);
      return 0;
    case TIOCPKT:
      ctx.sys.setPacketMode(fd, v.getInt32(argp, true) !== 0);
      return 0;
    default: {
      const word = v.getInt32(argp, true);
      ctx.sys.setWinsize(fd, word & 0xffff, (word >>> 16) & 0xffff);
      return 0;
    }
  }
}

const PTY_REQUESTS: ReadonlySet<number> = new Set([
  TIOCGPTN,
  TIOCSPTLCK,
  TIOCSCTTY,
  TIOCSWINSZ,
  TIOCPKT,
]);

const TTY_NOOPS: ReadonlySet<number> = new Set([TCSBRK, TCXONC, TCXONC + 1, TCXONC + 2, TCFLSH]);

function ptyRequest(ctx: EmContext, fd: number, request: number, argp: () => number): number {
  ctx.host.fds.get(fd);
  if (isKernel(ctx, fd)) return ptyIoctl(ctx, fd, request, argp());
  if (request === TIOCSWINSZ) return isTty(ctx, fd) ? 0 : -EM.NOTTY;
  return -EM.INVAL;
}

function termiosRequest(ctx: EmContext, fd: number, request: number, argp: () => number): number {
  if (!isTty(ctx, fd)) return -EM.NOTTY;
  if (request === TCGETS) {
    const t = ctx.sys.tcgets?.(fd);
    if (t) writeTermios(ctx, argp(), t);
    return 0;
  }
  if (!ctx.sys.tcsets) return 0;
  ctx.sys.tcsets(fd, readTermios(ctx, argp()), request === TCSETSF);
  return 0;
}

function winsize(ctx: EmContext, fd: number, argp: () => number): number {
  if (!isTty(ctx, fd)) return -EM.NOTTY;
  const [rows, cols] = ctx.sys.winsize?.(fd) ?? [24, 80];
  const at = argp();
  const v = ctx.mem.view();
  v.setInt16(at, rows, true);
  v.setInt16(at + 2, cols, true);
  return 0;
}

function ioctl(ctx: EmContext, fd: number, op: number, varargs: number): number {
  const request = op >>> 0;
  const argp = () => ctx.mem.view().getUint32(varargs, true);
  if (PTY_REQUESTS.has(request)) return ptyRequest(ctx, fd, request, argp);
  if (TTY_NOOPS.has(request)) return isTty(ctx, fd) ? 0 : -EM.NOTTY;
  if (request === TCGETS || request === TCSETS || request === TCSETSW || request === TCSETSF) {
    return termiosRequest(ctx, fd, request, argp);
  }
  if (request === TIOCGWINSZ) return winsize(ctx, fd, argp);
  if (request === TIOCGPGRP) {
    if (!isTty(ctx, fd)) return -EM.NOTTY;
    ctx.mem.view().setInt32(argp(), 0, true);
    return 0;
  }
  if (request === TIOCSPGRP) return isTty(ctx, fd) ? -EM.INVAL : -EM.NOTTY;
  ctx.host.fds.get(fd);
  return request === FIONREAD || request === FIONBIO ? -EM.NOTTY : -EM.INVAL;
}

function lockAllowed(ctx: EmContext, fd: number, varargs: number): boolean {
  const at = ctx.mem.view().getUint32(varargs, true);
  const type = ctx.mem.view().getInt16(at, true);
  const acc = fdFlags(ctx, fd) & 3;
  if (type === 0) return acc !== 1;
  if (type === 1) return acc !== 0;
  return true;
}

function fcntl(ctx: EmContext, fd: number, cmd: number, varargs: number): number {
  const { fds } = ctx.host;
  const arg = () => ctx.mem.view().getInt32(varargs, true);
  fds.get(fd);
  switch (cmd) {
    case F_DUPFD:
    case F_DUPFD_CLOEXEC: {
      const min = arg();
      if (min < 0) return -EM.INVAL;
      return fds.dup(fd, min, cmd === F_DUPFD_CLOEXEC);
    }
    case F_GETFD:
      return fds.cloexec.has(fd) ? FD_CLOEXEC : 0;
    case F_SETFD:
      fds.setCloexec(fd, (arg() & FD_CLOEXEC) !== 0);
      return 0;
    case F_GETFL:
      return fdFlags(ctx, fd);
    case F_SETFL: {
      const flags = arg();
      fds.setFlags(fd, (flags & O_NONBLOCK) !== 0, (flags & O_APPEND) !== 0);
      return 0;
    }
    case F_GETLK:
    case F_SETLK:
    case F_SETLKW: {
      if (cmd !== F_GETLK && !lockAllowed(ctx, fd, varargs)) return -EM.BADF;
      const lock = ctx.host.sliccImports().fcntl_lock as (
        fd: number,
        cmd: number,
        at: number
      ) => number;
      const r = lock(fd, cmd, ctx.mem.view().getUint32(varargs, true));
      return r === 0 ? 0 : -r;
    }
    default:
      return -EM.INVAL;
  }
}

function pollMask(ctx: EmContext, fd: number): number {
  const e = ctx.host.fds.find(fd);
  if (!e) return POLLNVAL;
  if (e.type !== 'kernel') return POLLIN | POLLOUT;
  const state = ctx.sys.poll(fd);
  let mask = 0;
  if (state.readable) mask |= POLLIN | POLLRDNORM;
  if (state.writable) mask |= POLLOUT | POLLWRNORM;
  if (state.hangup) mask |= state.readable ? POLLHUP : POLLERR;
  return mask;
}

interface Ready {
  read: number[];
  write: number[];
}

export function select(ctx: EmContext, read: number[], write: number[], timeoutMs: number): Ready {
  const { fds } = ctx.host;
  const localRead: number[] = [];
  const localWrite: number[] = [];
  const kernelRead: number[] = [];
  const kernelWrite: number[] = [];
  for (const fd of read) {
    const e = fds.find(fd);
    if (e?.type === 'kernel') kernelRead.push(fd);
    else localRead.push(fd);
  }
  for (const fd of write) {
    const e = fds.find(fd);
    if (e?.type === 'kernel') kernelWrite.push(fd);
    else localWrite.push(fd);
  }
  const local = localRead.length + localWrite.length > 0;
  if (kernelRead.length + kernelWrite.length === 0 && local) {
    return { read: localRead, write: localWrite };
  }
  const got = ctx.call({
    op: 'fd-select',
    read: kernelRead,
    write: kernelWrite,
    timeoutMs: local ? 0 : timeoutMs,
  }) as Ready;
  const out: Ready = { read: [], write: [] };
  for (const fd of read) {
    if (localRead.includes(fd) || got.read.includes(fd)) out.read.push(fd);
  }
  for (const fd of write) {
    if (localWrite.includes(fd) || got.write.includes(fd)) out.write.push(fd);
  }
  return out;
}

function bitsOf(ctx: EmContext, set: number, n: number): number[] {
  const out: number[] = [];
  if (!set) return out;
  const v = ctx.mem.view();
  for (let fd = 0; fd < n; fd++) {
    if (v.getUint32(set + (fd >> 5) * 4, true) & (1 << (fd & 31))) out.push(fd);
  }
  return out;
}

function storeBits(ctx: EmContext, set: number, n: number, ready: number[]): void {
  if (!set) return;
  const v = ctx.mem.view();
  for (let w = 0; w < (n + 31) >> 5; w++) v.setUint32(set + w * 4, 0, true);
  for (const fd of ready) {
    const at = set + (fd >> 5) * 4;
    v.setUint32(at, (v.getUint32(at, true) | (1 << (fd & 31))) >>> 0, true);
  }
}

function blockingPoll(ctx: EmContext, ptr: number, n: number, timeoutMs: number): number {
  const IN = POLLIN | POLLRDNORM;
  const OUT = POLLOUT | POLLWRNORM;
  const v = () => ctx.mem.view();
  const read: number[] = [];
  const write: number[] = [];
  for (let i = 0; i < n; i++) {
    const fd = v().getInt32(ptr + i * 8, true);
    const events = v().getInt16(ptr + i * 8 + 4, true);
    if (fd < 0) continue;
    if (events & IN) read.push(fd);
    if (events & OUT) write.push(fd);
  }
  const ready = select(ctx, read, write, timeoutMs);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const fd = v().getInt32(ptr + i * 8, true);
    const events = v().getInt16(ptr + i * 8 + 4, true);
    let revents = 0;
    if (fd >= 0 && ready.read.includes(fd)) revents |= events & IN;
    if (fd >= 0 && ready.write.includes(fd)) revents |= events & OUT;
    v().setInt16(ptr + i * 8 + 6, revents, true);
    if (revents) count++;
  }
  return count;
}

export function fdImports(ctx: EmContext): WebAssembly.ModuleImports {
  const { fds } = ctx.host;
  return {
    __syscall_dup: negated((fd: number) => fds.dup(fd, 0, false)),
    __syscall_dup3: negated((fd: number, newfd: number, flags: number) => {
      fds.get(fd);
      if (fd === newfd) return -EM.INVAL;
      if (newfd < 0 || newfd >= 4096) return -EM.BADF;
      fds.renumber(fd, newfd, true);
      if (flags & O_CLOEXEC) fds.setCloexec(newfd, true);
      return newfd;
    }),
    __syscall_fcntl64: negated((fd: number, cmd: number, varargs: number) =>
      fcntl(ctx, fd, cmd, varargs)
    ),
    __syscall_ioctl: negated((fd: number, op: number, varargs: number) =>
      ioctl(ctx, fd, op, varargs)
    ),
    __syscall_pipe: negated((ptr: number) => {
      if (ptr === 0) return -EM.FAULT;
      const [r, w] = fds.pipe();
      const v = ctx.mem.view();
      v.setInt32(ptr, r, true);
      v.setInt32(ptr + 4, w, true);
    }),
    __syscall_flock: negated((fd: number, op: number) => {
      const flock = ctx.host.sliccImports().flock as (fd: number, op: number) => number;
      const r = flock(fd, op);
      return r === 0 ? 0 : -r;
    }),
    _poll_js: negated((ptr: number, nfds: number) => {
      let count = 0;
      const v = () => ctx.mem.view();
      for (let i = 0; i < nfds; i++) {
        const at = ptr + 8 * i;
        const fd = v().getInt32(at, true);
        const events = v().getInt16(at + 4, true);
        const flags = pollMask(ctx, fd) & (events | POLLERR | POLLHUP);
        if (flags) count++;
        v().setInt16(at + 6, flags, true);
      }
      return count;
    }),
    slicc_select_js: negated((n: number, rfds: number, wfds: number, timeoutMs: number) => {
      const r = select(ctx, bitsOf(ctx, rfds, n), bitsOf(ctx, wfds, n), timeoutMs);
      storeBits(ctx, rfds, n, r.read);
      storeBits(ctx, wfds, n, r.write);
      return r.read.length + r.write.length;
    }),
    slicc_poll_js: negated((ptr: number, n: number, timeoutMs: number) =>
      blockingPoll(ctx, ptr, n, timeoutMs)
    ),
  };
}
