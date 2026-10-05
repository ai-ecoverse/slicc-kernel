import type { HttpHead, HttpSyscall } from '../kernel/net/http-syscalls.ts';
import type { HeaderList } from '../kernel/net/transport.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import type { SyncSabTransport } from '../realm/sync-sab-bridge.ts';

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: HeaderList;
  body?: Uint8Array;
}

export interface HttpKernel {
  request(req: HttpRequest): HttpHead;
  read(handle: number, max: number): Uint8Array;
  close(handle: number): void;
}

export class HttpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function createHttpKernel(transport: SyncSabTransport): HttpKernel {
  const call = (req: HttpSyscall): SyncFsResult => {
    const r = transport.call(req, Number.POSITIVE_INFINITY, req.op);
    if (!r.ok) throw new HttpError(r.errno, r.message);
    return r;
  };
  return {
    request(req) {
      const r = call({
        op: 'net-request',
        url: req.url,
        method: (req.method ?? 'GET').toUpperCase(),
        headers: req.headers ?? [],
        ...(req.body ? { body: req.body } : {}),
      });
      return (r as Extract<SyncFsResult, { kind: 'json' }>).json as HttpHead;
    },
    read(handle, max) {
      return (call({ op: 'net-read', handle, max }) as Extract<SyncFsResult, { kind: 'bytes' }>)
        .bytes;
    },
    close(handle) {
      call({ op: 'net-close', handle });
    },
  };
}
