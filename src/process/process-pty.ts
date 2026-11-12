import { FILE_IOCTLS, ioctlArg, ioctlResult } from '../kernel/serial-ioctl.ts';
import type { ProcessFs, ProcessStream } from './kernel-streams.ts';
import type { GlueSyscall } from './process-fds.ts';
import { wasiErrno } from './wasi-errno.ts';

export const TIOCGPTN = 0x80045430;
export const TIOCSPTLCK = 0x40045431;
export const TIOCSCTTY = 0x540e;
export const TIOCSWINSZ = 0x5414;
export const TIOCPKT = 0x5420;

export interface PtyKernel {
  ptyNumber(kfd: number): number;

  ptyLock(kfd: number, lock: boolean): void;

  setControllingTerminal(kfd: number): void;

  setPacketMode(kfd: number, on: boolean): void;

  setWinsize(kfd: number, rows: number, cols: number): void;

  devIoctl?(fd: number, request: number, arg?: unknown): unknown;
}

export interface PtyIoctlDeps {
  fs(): ProcessFs | undefined;

  heap(): Int32Array | undefined;
  kernel: PtyKernel;
}

function failed(e: unknown): number {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return -wasiErrno(code);
  throw e;
}

function deviceIoctl(
  stream: ProcessStream,
  request: number,
  varargs: number,
  deps: PtyIoctlDeps
): number {
  const heap = deps.heap();
  if (!heap) return -wasiErrno('EFAULT');
  const view = new DataView(heap.buffer);
  const argp = (heap[varargs >> 2] ?? 0) >>> 0;
  try {
    const arg = ioctlArg(view, request, argp);
    const kernel = deps.kernel as Required<Pick<PtyKernel, 'devIoctl'>>;
    const result = kernel.devIoctl(stream.sliccKernelFd as number, request, arg);
    ioctlResult(new DataView(heap.buffer), request, argp, result);
    return 0;
  } catch (e) {
    return failed(e);
  }
}

export function ptyIoctl(ioctl: GlueSyscall, deps: PtyIoctlDeps): GlueSyscall {
  return (fd, op, varargs) => {
    const request = op >>> 0;
    const device = deps.fs()?.getStream(fd);
    if (device?.sliccDevice && deps.kernel.devIoctl && !FILE_IOCTLS.has(request))
      return deviceIoctl(device, request, varargs ?? 0, deps);
    if (
      request !== TIOCGPTN &&
      request !== TIOCSPTLCK &&
      request !== TIOCSCTTY &&
      request !== TIOCSWINSZ &&
      request !== TIOCPKT
    ) {
      return ioctl(fd, op, varargs);
    }
    const stream = deps.fs()?.getStream(fd);
    const kfd = (stream as { sliccKernelFd?: number } | undefined)?.sliccKernelFd;

    if (kfd === undefined) return ioctl(fd, op, varargs);
    const heap = deps.heap();
    if (!heap) return -wasiErrno('EFAULT');
    const argp = (heap[varargs >> 2] ?? 0) >>> 0;
    try {
      return answer(request, kfd, argp, heap, deps.kernel);
    } catch (e) {
      return failed(e);
    }
  };
}

function answer(
  request: number,
  kfd: number,
  argp: number,
  heap: Int32Array,
  kernel: PtyKernel
): number {
  switch (request) {
    case TIOCGPTN:
      heap[argp >> 2] = kernel.ptyNumber(kfd);
      return 0;
    case TIOCSPTLCK:
      kernel.ptyLock(kfd, (heap[argp >> 2] ?? 0) !== 0);
      return 0;
    case TIOCSCTTY:
      kernel.setControllingTerminal(kfd);
      return 0;
    case TIOCPKT:
      kernel.setPacketMode(kfd, (heap[argp >> 2] ?? 0) !== 0);
      return 0;
    default: {
      const word = heap[argp >> 2] ?? 0;
      kernel.setWinsize(kfd, word & 0xffff, (word >>> 16) & 0xffff);
      return 0;
    }
  }
}
