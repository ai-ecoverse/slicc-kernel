import { HttpError } from '../kernel/net/http1.ts';
import type { KernelSocket } from '../kernel/socket.ts';
import { heldConnection } from './held.ts';
import { LEASE_MAX_CONNECTIONS } from './lease.ts';
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
  private readonly leaseTag: string | undefined;
  private readonly sessionOf: (pid: number) => number;
  private session: number | undefined;
  private opening = 0;
  readonly path: string;
  readonly url: string;

  constructor(hook?: CdpHook, leaseTag?: string, sessionOf = (_pid: number) => -1) {
    this.leaseTag = leaseTag;
    this.sessionOf = sessionOf;
    this.path = `${this.leaseOnly ? '/slicc/lease/v1/' : '/devtools/browser/'}${crypto.randomUUID()}`;
    this.url = `ws://127.0.0.1:${CDP_PORT}${this.path}`;
    this.embedder = hook ? { hook, runtime: undefined, open: new Set() } : undefined;
  }

  get leaseOnly(): boolean {
    return this.leaseTag !== undefined;
  }

  env(): Record<string, string> {
    return { [this.leaseOnly ? 'SLICC_CDP_LEASE_URL' : 'SLICC_CDP_URL']: this.url };
  }

  bindClient(
    session: number,
    tag: string | undefined,
    extraHost: unknown
  ): (() => void) | undefined {
    if (!this.leaseOnly) return undefined;
    if (this.closed || this.session !== undefined || tag !== this.leaseTag || extraHost) {
      throw new Error('lease unavailable for this client');
    }
    this.session = session;
    return () => this.close();
  }

  authorize(socket: KernelSocket): void {
    if (!this.leaseOnly) return;
    if (
      this.closed ||
      this.session === undefined ||
      socket.peerStamp?.tag !== this.leaseTag ||
      !socket.peerCred ||
      this.sessionOf(socket.peerCred.pid) !== this.session
    ) {
      throw new HttpError(403, 'lease unavailable');
    }
  }

  register(hook: CdpHook, runtime?: string): () => void {
    if (this.leaseOnly) throw new Error('a lease-only kernel cannot register a CDP host');
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
    if (this.leaseOnly) return runtime === undefined ? this.embedder : undefined;
    const named = runtime ? this.clients.findLast((c) => c.runtime === runtime) : undefined;
    return named ?? this.embedder ?? this.clients.at(-1);
  }

  available(runtime?: string): boolean {
    return this.pick(runtime) !== undefined;
  }

  async connect(peer: KernelSocket, runtime?: string): Promise<CdpConnection> {
    this.authorize(peer);
    const entry = this.pick(runtime);
    if (!entry) throw new HttpError(503, NO_CDP_HOST);
    if (this.leaseOnly && this.opening + entry.open.size >= LEASE_MAX_CONNECTIONS)
      throw new HttpError(503, 'lease busy');
    let conn: CdpConnection;
    this.opening++;
    try {
      conn = held(await entry.hook(hookRequest(peer, runtime)));
    } catch (e) {
      if (this.leaseOnly) throw new HttpError(502, 'lease unavailable');
      throw new HttpError(502, `CDP host: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.opening--;
    }
    if (this.closed || !(entry === this.embedder || this.clients.includes(entry))) {
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

function held(host: CdpConnection): CdpConnection {
  const { conn, message, end } = heldConnection(
    (m) => host.send(m),
    () => host.close()
  );
  host.onmessage = message;
  host.onclose = end;
  return conn;
}

function hookRequest({ peerStamp: stamp }: KernelSocket, runtime?: string): CdpRequest {
  return {
    ...(runtime ? { runtime } : {}),
    ...(stamp ? { stamp: structuredClone(stamp) } : {}),
  };
}

function closeAll(entry: Registration): void {
  for (const conn of [...entry.open]) {
    conn.close();
    conn.onclose?.('the CDP host is gone');
  }
}
