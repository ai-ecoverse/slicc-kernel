import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import { NO_TRANSPORT } from './network.ts';
import type { HeaderList, RealmTransport } from './transport.ts';

export type HttpSyscall =
  | {
      op: 'net-request';
      url: string;
      method: string;
      headers: HeaderList;
      body?: Uint8Array;
    }
  | { op: 'net-read'; handle: number; max: number }
  | { op: 'net-close'; handle: number };

export const HTTP_OPS: readonly string[] = ['net-request', 'net-read', 'net-close'];

export interface HttpHead {
  handle: number;
  status: number;
  statusText: string;
  url: string;
  headers: HeaderList;
}

interface Open {
  abort: AbortController;
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

  constructor(transport: RealmTransport) {
    this.transport = transport;
  }

  syscall(req: HttpSyscall): Promise<SyncFsResult> {
    if (req.op === 'net-request') return this.request(req);
    if (req.op === 'net-read') return this.read(req.handle, req.max);
    return this.close(req.handle);
  }

  private add(
    abort: AbortController,
    body: AsyncIterable<Uint8Array>,
    cancel: () => Promise<void>
  ) {
    const handle = ++this.nextHandle;
    this.open.set(handle, {
      abort,
      body: body[Symbol.asyncIterator](),
      left: EMPTY,
      done: false,
      reading: Promise.resolve(),
      cancel,
    });
    return handle;
  }

  private async request(req: Extract<HttpSyscall, { op: 'net-request' }>): Promise<SyncFsResult> {
    const abort = new AbortController();
    try {
      const response = await this.transport.fetch({
        url: req.url,
        method: req.method,
        headers: req.headers,
        ...(req.body ? { body: req.body } : {}),
        signal: abort.signal,
      });
      const handle = this.add(abort, response.body, () => response.cancel());
      const head: HttpHead = {
        handle,
        status: response.status,
        statusText: response.statusText,
        url: req.url,
        headers: response.headers,
      };
      return { ok: true, kind: 'json', json: head };
    } catch (e) {
      const text = message(e);
      if (text === NO_TRANSPORT) return { ok: false, errno: 'ENETUNREACH', message: text };
      const status = (e as { status?: unknown }).status;
      if (typeof status !== 'number' || status === 502) {
        return { ok: false, errno: 'ECONNREFUSED', message: text };
      }
      const body = new TextEncoder().encode(text);
      const handle = this.add(abort, once(body), async () => undefined);
      const head: HttpHead = {
        handle,
        status,
        statusText: '',
        url: req.url,
        headers: [['content-type', 'text/plain; charset=utf-8']],
      };
      return { ok: true, kind: 'json', json: head };
    }
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
        return { ok: false, errno: 'EIO', message: message(e) };
      }
    }
    const bytes = entry.left.subarray(0, Math.max(0, max));
    entry.left = entry.left.subarray(bytes.length);
    return { ok: true, kind: 'bytes', bytes };
  }

  private async close(handle: number): Promise<SyncFsResult> {
    const entry = this.open.get(handle);
    if (!entry) return { ok: false, errno: 'EBADF', message: `no request ${handle}` };
    this.open.delete(handle);
    entry.abort.abort();
    await entry.cancel().catch(() => undefined);
    return { ok: true, kind: 'void' };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((handle) => this.close(handle)));
  }
}
