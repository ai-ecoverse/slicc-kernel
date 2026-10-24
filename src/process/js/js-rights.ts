import type { WasmSyscall } from '../../kernel/process.ts';
import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';

const jsonOf = (r: SyncFsResult): unknown => (r.ok && r.kind === 'json' ? r.json : undefined);
const bytesOf = (r: SyncFsResult): Uint8Array =>
  r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(8);

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
  blocking(req: WasmSyscall, signal?: AbortSignal): Promise<SyncFsResult>;
  call(req: SyncSabRequestBody): Promise<SyncFsResult>;
}

type Watch = (fd: number) => { signal: AbortSignal; done(): void };

async function blocked(
  kernel: AsyncKernel,
  watch: Watch,
  req: WasmSyscall & { fd: number; nonblock: boolean }
) {
  if (req.nonblock) return kernel.call(req);
  const { signal, done } = watch(req.fd);
  try {
    return await kernel.blocking(req, signal);
  } finally {
    done();
  }
}

export function rightsAsync(kernel: AsyncKernel, forget: (fd: number) => void, watch: Watch) {
  return {
    socketpair: async () =>
      (await kernel.json({ op: 'sock-pair', domain: 'unix', type: 'stream' })) as [number, number],
    sendmsg: async (fd: number, data: Uint8Array | string, options?: JsSendmsgOptions) =>
      jsonOf(await blocked(kernel, watch, sendmsgRequest(fd, data, options))) as number,
    async recvmsg(fd: number, max?: number, options?: JsRecvmsgOptions): Promise<JsReceived> {
      const got = decodeReceived(
        bytesOf(await blocked(kernel, watch, recvmsgRequest(fd, max, options)))
      );
      for (const n of got.fds) forget(n);
      return got;
    },
  };
}
