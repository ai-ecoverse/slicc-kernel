import type { EpollEvent, EpollOp } from '../../kernel/epoll.ts';
import { E } from './wasi-abi.ts';
import { WasiError } from './wasi-files.ts';
import type { WasiFunction, WasiHost } from './wasi-host.ts';

const EVENT_SIZE = 32;
const DATA_OFFSET = 8;
const DATA_SIZE = 24;
const MAX_EVENTS = 4096;
const FOREVER = 0xffff_ffff_ffff_ffffn;
const MAX_TIMEOUT_MS = 0x7fff_ffff;
const NS_PER_MS = 1_000_000n;
const EVENTFD_SEMAPHORE = 1;
const EVENTFD_NONBLOCK = 4;
const EVENTFD_MAX = 0xffff_ffff_ffff_fffen;
const WASIX_OPS: readonly EpollOp[] = ['add', 'mod', 'del'];
const DUAL_OPS: readonly EpollOp[] = ['add', 'set', 'del', 'mod'];

export function timeoutMs(ns: bigint): number {
  const value = BigInt.asUintN(64, ns);
  if (value === FOREVER) return -1;
  const ms = (value + NS_PER_MS - 1n) / NS_PER_MS;
  return ms > BigInt(MAX_TIMEOUT_MS) ? -1 : Number(ms);
}

export function wasixEpollImports(host: WasiHost): Record<string, WasiFunction> {
  const { mem, fds, o } = host;
  const call = (req: Parameters<typeof o.kernel.call>[0]) => o.kernel.call(req);
  const kernelFd = (fd: number, refusal: 'EINVAL' | 'EPERM'): void => {
    const e = fds.find(fd);
    if (!e) throw new WasiError('EBADF');
    if (e.type !== 'kernel') throw new WasiError(refusal);
  };
  const writeEvents = (ptr: number, events: readonly EpollEvent[]): void => {
    const view = mem.view();
    events.forEach((ev, i) => {
      const at = ptr + i * EVENT_SIZE;
      mem.bytes(at, EVENT_SIZE).fill(0);
      view.setUint32(at, ev.events, true);
      mem.bytes(at + DATA_OFFSET, DATA_SIZE).set(ev.data);
    });
  };
  return {
    epoll_create: (out: number) => {
      const fd = call({ op: 'epoll-create' }) as number;
      fds.adopt(fd, 'stream', false);
      mem.view().setUint32(out, fd, true);
    },
    epoll_ctl: (epfd: number, op: number, fd: number, event: number) => {
      const how = (host.strictEpoll ? WASIX_OPS : DUAL_OPS)[op];
      if (!how) throw new WasiError('EINVAL');
      kernelFd(epfd, 'EINVAL');
      kernelFd(fd, 'EPERM');
      if (how !== 'del' && event === 0) throw new WasiError('EINVAL');
      const events = event === 0 ? 0 : mem.view().getUint32(event, true);
      const data = event === 0 ? [] : [...mem.bytes(event + DATA_OFFSET, DATA_SIZE)];
      call({ op: 'epoll-ctl', epfd, how, fd, events, data });
    },
    epoll_wait: (epfd: number, ptr: number, maxevents: number, timeout: bigint, out: number) => {
      mem.view().setUint32(out, 0, true);
      if ((maxevents | 0) <= 0) throw new WasiError('EINVAL');
      kernelFd(epfd, 'EINVAL');
      const max = Math.min(maxevents | 0, MAX_EVENTS);
      const ms = host.entered ? 0 : timeoutMs(timeout);
      const events = call({ op: 'epoll-wait', epfd, max, timeoutMs: ms }) as EpollEvent[];
      if (host.entered && events.length === 0 && timeoutMs(timeout) !== 0) return E.INTR;
      writeEvents(ptr, events);
      mem.view().setUint32(out, events.length, true);
      return E.SUCCESS;
    },
    fd_event: (initial: bigint, flags: number, out: number) => {
      const value = BigInt.asUintN(64, initial);
      if (value > EVENTFD_MAX) throw new WasiError('EINVAL');
      const fd = call({
        op: 'eventfd-open',
        initial: value.toString(),
        semaphore: (flags & EVENTFD_SEMAPHORE) !== 0,
      }) as number;
      fds.adopt(fd, 'stream', (flags & EVENTFD_NONBLOCK) !== 0);
      mem.view().setUint32(out, fd, true);
    },
  };
}
