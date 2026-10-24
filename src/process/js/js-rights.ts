import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';

export interface JsSendmsgOptions {
  fds?: number[];
  nonblock?: boolean;
}

export interface JsRecvmsgOptions {
  cloexec?: boolean;
  nonblock?: boolean;
}

export interface JsReceived {
  bytes: Uint8Array;
  fds: number[];
  ctrunc: boolean;
}

const encoder = new TextEncoder();
const RECV_DEFAULT = 64 * 1024;

export function sendmsgRequest(
  fd: number,
  data: Uint8Array | string,
  options: JsSendmsgOptions = {}
) {
  return {
    op: 'sock-sendmsg' as const,
    fd,
    body: typeof data === 'string' ? encoder.encode(data) : data,
    fds: options.fds ?? [],
    nonblock: options.nonblock === true,
  };
}

export function recvmsgRequest(fd: number, max = RECV_DEFAULT, options: JsRecvmsgOptions = {}) {
  return {
    op: 'sock-recvmsg' as const,
    fd,
    max,
    cloexec: options.cloexec === true,
    nonblock: options.nonblock === true,
  };
}

export function decodeReceived(frame: Uint8Array): JsReceived {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const count = view.getUint32(0, true);
  const fds: number[] = [];
  for (let i = 0; i < count; i++) fds.push(view.getUint32(8 + i * 4, true));
  return {
    bytes: frame.slice(8 + count * 4),
    fds,
    ctrunc: (view.getUint32(4, true) & 1) === 1,
  };
}

interface AsyncKernel {
  json(req: SyncSabRequestBody): Promise<unknown>;
  bytes(req: SyncSabRequestBody): Promise<Uint8Array>;
}

export function rightsAsync(kernel: AsyncKernel, forget: (fd: number) => void) {
  return {
    socketpair: async () =>
      (await kernel.json({ op: 'sock-pair', domain: 'unix', type: 'stream' })) as [number, number],
    sendmsg: async (fd: number, data: Uint8Array | string, options?: JsSendmsgOptions) =>
      (await kernel.json(sendmsgRequest(fd, data, options))) as number,
    async recvmsg(fd: number, max?: number, options?: JsRecvmsgOptions): Promise<JsReceived> {
      const got = decodeReceived(await kernel.bytes(recvmsgRequest(fd, max, options)));
      for (const n of got.fds) forget(n);
      return got;
    },
  };
}
