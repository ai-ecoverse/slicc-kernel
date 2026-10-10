import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import { NO_TRANSPORT } from './network.ts';
import type { HeaderList, RealmTransport } from './transport.ts';
import { WS_OPS, WsHandles, type WsSyscall } from './ws-syscalls.ts';

export interface HttpRequestBody {
  url: string;
  method: string;
  headers: HeaderList;
  body?: Uint8Array;
}

export type HttpSyscall =
  | ({ op: 'net-request' } & HttpRequestBody)
  | ({ op: 'net-open' } & HttpRequestBody)
  | { op: 'net-head'; handle: number }
  | { op: 'net-read'; handle: number; max: number }
  | { op: 'net-close'; handle: number }
  | { op: 'net-traits' }
  | WsSyscall;

export const HTTP_OPS: readonly string[] = [
  'net-request',
  'net-open',
  'net-head',
  'net-read',
  'net-close',
  'net-traits',
  ...WS_OPS,
];

export interface HttpHead {
  handle: number;
  status: number;
  statusText: string;
  url: string;
  redirected?: boolean;
  headers: HeaderList;
}

interface Open {
  abort: AbortController;
  head: Promise<SyncFsResult>;
  body: AsyncIterator<Uint8Array>;
  left: Uint8Array;
  done: boolean;
  reading: Promise<void>;
  cancel(): Promise<void>;
}

const EMPTY = new Uint8Array(0);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

export class HttpHandles {
  private readonly transport: RealmTransport;

  private readonly open = new Map<number, Open>();

  private nextHandle = 0;

  private readonly ws: WsHandles;

  constructor(transport: RealmTransport) {
    this.transport = transport;
    this.ws = new WsHandles(transport, () => ++this.nextHandle);
  }

  syscall(req: HttpSyscall): Promise<SyncFsResult> {
    if (req.op.startsWith('net-ws-')) return this.ws.syscall(req as WsSyscall);
    if (req.op === 'net-request') return this.request(req);
    if (req.op === 'net-open') return Promise.resolve(this.opened(req));
    if (req.op === 'net-head') return this.head(req.handle);
    if (req.op === 'net-read') return this.read(req.handle, req.max);
    if (req.op === 'net-traits') return Promise.resolve(this.traits());
    return this.close((req as { handle: number }).handle);
  }

  private traits(): SyncFsResult {
    const { unavailable, crossOrigin = 'any', ...rest } = this.transport.traits;
    if (unavailable) return { ok: false, errno: 'ENETUNREACH', message: NO_TRANSPORT };
    return { ok: true, kind: 'json', json: { ...rest, crossOrigin } };
  }

  private async request(req: HttpRequestBody): Promise<SyncFsResult> {
    const { handle, head } = this.start(req);
    const result = await head;
    if (!result.ok) this.open.delete(handle);
    return result;
  }

  private opened(req: HttpRequestBody): SyncFsResult {
    return { ok: true, kind: 'json', json: this.start(req).handle };
  }

  private start(req: HttpRequestBody): { handle: number; head: Promise<SyncFsResult> } {
    const handle = ++this.nextHandle;
    const abort = new AbortController();
    const entry: Open = {
      abort,
      head: Promise.resolve({ ok: true, kind: 'void' }),
      body: once(EMPTY),
      left: EMPTY,
      done: false,
      reading: Promise.resolve(),
      cancel: async () => undefined,
    };
    this.open.set(handle, entry);
    entry.head = this.respond(handle, req, entry);
    return { handle, head: entry.head };
  }

  private async respond(handle: number, req: HttpRequestBody, entry: Open): Promise<SyncFsResult> {
    try {
      const response = await this.transport.fetch({
        url: req.url,
        method: req.method,
        headers: req.headers,
        ...(req.body ? { body: req.body } : {}),
        signal: entry.abort.signal,
      });
      entry.body = response.body[Symbol.asyncIterator]();
      entry.cancel = () => response.cancel();
      if (!this.open.has(handle)) await entry.cancel().catch(() => undefined);
      const head = this.headOf(handle, response.url ?? req.url, response);
      return response.redirected ? { ...head, json: { ...head.json, redirected: true } } : head;
    } catch (e) {
      const text = message(e);
      const status = (e as { status?: unknown }).status;
      if (text === NO_TRANSPORT || typeof status !== 'number' || status === 502) {
        const errno = text === NO_TRANSPORT ? 'ENETUNREACH' : 'ECONNREFUSED';
        return { ok: false, errno, message: text };
      }
      entry.body = once(new TextEncoder().encode(text))[Symbol.asyncIterator]();
      return this.headOf(handle, req.url, {
        status,
        statusText: '',
        headers: [['content-type', 'text/plain; charset=utf-8']],
      });
    }
  }

  private headOf(
    handle: number,
    url: string,
    response: { status: number; statusText: string; headers: HeaderList }
  ): { ok: true; kind: 'json'; json: HttpHead } {
    const { status, statusText, headers } = response;
    return { ok: true, kind: 'json', json: { handle, status, statusText, url, headers } };
  }

  private head(handle: number): Promise<SyncFsResult> {
    const entry = this.open.get(handle);
    if (!entry)
      return Promise.resolve({ ok: false, errno: 'EBADF', message: `no request ${handle}` });
    return entry.head;
  }

  private async read(handle: number, max: number): Promise<SyncFsResult> {
    const entry = this.open.get(handle);
    if (!entry) return { ok: false, errno: 'EBADF', message: `no request ${handle}` };
    const turn = entry.reading.then(() => this.take(entry, max));
    entry.reading = turn.then(() => undefined);
    return turn;
  }

  private async take(entry: Open, max: number): Promise<SyncFsResult> {
    if (entry.left.length === 0 && !entry.done) {
      try {
        const next = await entry.body.next();
        if (next.done) entry.done = true;
        else entry.left = next.value;
      } catch (e) {
        entry.done = true;
        const timedOut = (e as { code?: unknown } | null)?.code === 'ETIMEDOUT';
        return { ok: false, errno: timedOut ? 'ETIMEDOUT' : 'EIO', message: message(e) };
      }
    }
    const bytes = entry.left.subarray(0, Math.max(0, max));
    entry.left = entry.left.subarray(bytes.length);
    return { ok: true, kind: 'bytes', bytes };
  }

  private async close(handle: number): Promise<SyncFsResult> {
    if (this.ws.owns(handle)) {
      this.ws.close(handle);
      return { ok: true, kind: 'void' };
    }
    const entry = this.open.get(handle);
    if (!entry) return { ok: false, errno: 'EBADF', message: `no request ${handle}` };
    this.open.delete(handle);
    entry.abort.abort();
    await entry.cancel().catch(() => undefined);
    return { ok: true, kind: 'void' };
  }

  async closeAll(): Promise<void> {
    this.ws.closeAll();
    await Promise.all([...this.open.keys()].map((handle) => this.close(handle)));
  }
}
