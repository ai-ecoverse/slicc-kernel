import { EpollFile } from './epoll.ts';
import {
  type FdTable,
  type KernelErrno,
  KernelError,
  type KernelFile,
  type OpenFile,
} from './fd-table.ts';
import { TlsContext } from './net/tls-server.ts';
import type { PipeMark } from './pipe.ts';
import { KernelSocket } from './socket.ts';
import { UnixDgram } from './unix-dgram.ts';

export const RIGHTS_MAX = 253;
export const RIGHTS_IN_FLIGHT = 1024;
const RECEIVE_MAX = 1024 * 1024;
const CTRUNC = 1;

interface Passed {
  file: OpenFile;
  status: number | undefined;
}

export class RightsMark implements PipeMark {
  readonly at: number;
  readonly passed: Passed[];
  constructor(at: number, passed: Passed[]) {
    this.at = at;
    this.passed = passed;
  }
  get count(): number {
    return this.passed.length;
  }
  drop(): void {
    for (const { file } of this.passed) void Promise.resolve(file.release()).catch(() => undefined);
  }
}

export function refusal(file: KernelFile): KernelErrno | undefined {
  if (file instanceof KernelSocket) {
    if (file.domain === 'unix') return 'EOPNOTSUPP';
    return file.secured ? 'EPERM' : undefined;
  }
  if (file instanceof UnixDgram) return 'EOPNOTSUPP';
  if (file instanceof EpollFile || file instanceof TlsContext) return 'EPERM';
  return file.sealed || file.clipboard || file.embedder ? 'EPERM' : undefined;
}

function carrierAt(fds: FdTable, fd: number): KernelSocket {
  const file = fds.get(fd).file;
  if (!(file instanceof KernelSocket)) {
    throw new KernelError(file instanceof UnixDgram ? 'EOPNOTSUPP' : 'ENOTSOCK');
  }
  return file;
}

export interface SendRights {
  fd: number;
  body: Uint8Array;
  fds: number[];
  nonblock: boolean;
}

export async function sendRights(
  fds: FdTable,
  req: SendRights,
  signal?: AbortSignal
): Promise<number> {
  const carrier = carrierAt(fds, req.fd);
  if (req.nonblock && !carrier.poll().writable) throw new KernelError('EAGAIN');
  if (req.nonblock) signal = AbortSignal.abort();
  if (req.fds.length === 0) return carrier.write(req.body, signal);
  if (req.fds.length > RIGHTS_MAX || req.body.length === 0) throw new KernelError('EINVAL');
  const passed = req.fds.map((fd) => ({ file: fds.get(fd), status: fds.statusFlags(fd) }));
  for (const { file } of passed) {
    const errno = refusal(file.file);
    if (errno) throw new KernelError(errno, 'this descriptor cannot be passed');
  }
  for (const { file } of passed) file.retain();
  let handed = false;
  const mark = (at: number, inFlight: number): RightsMark => {
    if (inFlight + passed.length > RIGHTS_IN_FLIGHT) {
      throw new KernelError('EMFILE', 'too many descriptors in flight');
    }
    handed = true;
    return new RightsMark(at, passed);
  };
  try {
    return await carrier.sendRights(req.body, mark, req.nonblock, signal);
  } catch (err) {
    if (!handed) new RightsMark(0, passed).drop();
    throw err;
  }
}

export interface ReceiveRights {
  fd: number;
  max: number;
  cloexec: boolean;
  nonblock: boolean;
}

function installed(fds: FdTable, passed: Passed, cloexec: boolean): number | undefined {
  let fd: number;
  try {
    fd = fds.install(passed.file);
  } catch {
    return undefined;
  }
  if (passed.status !== undefined) fds.setStatusFlags(fd, passed.status);
  if (cloexec) fds.setCloseOnExec(fd);
  return fd;
}

export function encodeRights(bytes: Uint8Array, got: number[], truncated: boolean): Uint8Array {
  const out = new Uint8Array(8 + got.length * 4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, got.length, true);
  view.setUint32(4, truncated ? CTRUNC : 0, true);
  for (const [i, fd] of got.entries()) view.setUint32(8 + i * 4, fd, true);
  out.set(bytes, 8 + got.length * 4);
  return out;
}

export async function receiveRights(
  fds: FdTable,
  req: ReceiveRights,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const carrier = carrierAt(fds, req.fd);
  const { bytes, marks } = await carrier.receiveRights(
    Math.min(req.max, RECEIVE_MAX),
    req.nonblock,
    signal
  );
  const got: number[] = [];
  let truncated = false;
  for (const mark of marks) {
    for (const passed of (mark as RightsMark).passed) {
      const fd = installed(fds, passed, req.cloexec);
      if (fd === undefined) truncated = true;
      else got.push(fd);
    }
  }
  return encodeRights(bytes, got, truncated);
}
