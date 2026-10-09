import { HttpError } from '../kernel/net/http1.ts';
import {
  CDP_PORT,
  type CdpConnection,
  type CdpHook,
  type CdpRequest,
  NO_CDP_HOST,
} from './types.ts';

interface Registration {
  hook: CdpHook;
  runtime: string | undefined;
  open: Set<CdpConnection>;
}

export class CdpHosts {
  private readonly embedder: Registration | undefined;
  private readonly clients: Registration[] = [];
  private closed = false;
  readonly path = `/devtools/browser/${crypto.randomUUID()}`;
  readonly url = `ws://127.0.0.1:${CDP_PORT}${this.path}`;

  constructor(hook?: CdpHook) {
    this.embedder = hook ? { hook, runtime: undefined, open: new Set() } : undefined;
  }

  register(hook: CdpHook, runtime?: string): () => void {
    const entry: Registration = { hook, runtime, open: new Set() };
    this.clients.push(entry);
    return () => {
      const at = this.clients.indexOf(entry);
      if (at >= 0) this.clients.splice(at, 1);
      closeAll(entry);
    };
  }

  private pick(runtime: string | undefined): Registration | undefined {
    if (this.closed) return undefined;
    const named = runtime ? this.clients.findLast((c) => c.runtime === runtime) : undefined;
    return named ?? this.embedder ?? this.clients.at(-1);
  }

  available(runtime?: string): boolean {
    return this.pick(runtime) !== undefined;
  }

  async connect(request: CdpRequest): Promise<CdpConnection> {
    const entry = this.pick(request.runtime);
    if (!entry) throw new HttpError(503, NO_CDP_HOST);
    let conn: CdpConnection;
    try {
      conn = await entry.hook(request.runtime ? { runtime: request.runtime } : {});
    } catch (e) {
      throw new HttpError(502, `CDP host: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.closed) {
      conn.close();
      throw new HttpError(503, NO_CDP_HOST);
    }
    entry.open.add(conn);
    const close = conn.close.bind(conn);
    conn.close = () => {
      if (entry.open.delete(conn)) close();
    };
    return conn;
  }

  close(): void {
    this.closed = true;
    for (const entry of [this.embedder, ...this.clients]) if (entry) closeAll(entry);
  }
}

function closeAll(entry: Registration): void {
  for (const conn of [...entry.open]) {
    conn.close();
    conn.onclose?.('the CDP host is gone');
  }
}
