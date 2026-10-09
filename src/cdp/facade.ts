import {
  HttpError,
  Incoming,
  latin1Bytes,
  parseRequestHead,
  REASON,
  type RequestHead,
} from '../kernel/net/http1.ts';
import type { KernelSocket, LoopbackNet } from '../kernel/socket.ts';
import type { CdpHosts } from './hosts.ts';
import { CDP_PORT, type CdpConnection, NO_CDP_HOST } from './types.ts';
import {
  acceptKey,
  CLOSE,
  closeFrame,
  frame,
  isUpgrade,
  MAX_MESSAGE,
  OP_TEXT,
  pongFrame,
  switchingHead,
  WsError,
  WsReader,
} from './websocket.ts';

const MAX_HEAD = 64 * 1024;
const LIST_TIMEOUT = 10000;

export interface CdpFacadeOptions {
  net: LoopbackNet;
  hosts: CdpHosts;
  port?: number;
  maxMessage?: number;
  listTimeout?: number;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

function respond(status: number, body: string, type = 'text/plain; charset=utf-8'): Uint8Array {
  const bytes = new TextEncoder().encode(body);
  const head = latin1Bytes(
    `HTTP/1.1 ${status} ${REASON[status]}\r\nContent-Type: ${type}\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`
  );
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head);
  out.set(bytes, head.length);
  return out;
}

function json(value: unknown): Uint8Array {
  return respond(200, `${JSON.stringify(value, null, 2)}\n`, 'application/json; charset=UTF-8');
}

export class CdpFacade {
  private readonly options: CdpFacadeOptions;
  private readonly listener: KernelSocket;
  private readonly stop = new AbortController();
  private readonly connections = new Set<KernelSocket>();
  readonly closed: Promise<void>;

  constructor(options: CdpFacadeOptions) {
    this.options = options;
    this.listener = options.net.listen({
      family: 'inet',
      host: '127.0.0.1',
      port: options.port ?? CDP_PORT,
    });
    this.closed = this.acceptLoop();
  }

  close(): void {
    if (this.stop.signal.aborted) return;
    this.stop.abort();
    this.listener.close();
    for (const conn of this.connections) conn.close();
  }

  private async acceptLoop(): Promise<void> {
    const served = new Set<Promise<void>>();
    for (;;) {
      let conn: KernelSocket;
      try {
        conn = await this.listener.accept(this.stop.signal);
      } catch {
        break;
      }
      const done = this.serve(conn).finally(() => served.delete(done));
      served.add(done);
    }
    await Promise.allSettled([...served]);
  }

  private async serve(conn: KernelSocket): Promise<void> {
    this.connections.add(conn);
    const incoming = new Incoming(conn);
    try {
      const head = await incoming.head(MAX_HEAD, this.stop.signal);
      if (head) await this.route(conn, incoming, parseRequestHead(head));
    } catch (e) {
      if (e instanceof HttpError) await this.write(conn, respond(e.status, `${e.message}\n`));
    } finally {
      this.connections.delete(conn);
      conn.close();
    }
  }

  private async write(conn: KernelSocket, bytes: Uint8Array): Promise<void> {
    try {
      await conn.write(bytes, this.stop.signal);
    } catch {}
  }

  private async route(conn: KernelSocket, incoming: Incoming, req: RequestHead): Promise<void> {
    const url = new URL(req.target, 'http://127.0.0.1');
    const runtime = url.searchParams.get('runtime') ?? undefined;
    const host = req.headers.find(([n]) => n.toLowerCase() === 'host')?.[1] ?? '127.0.0.1';
    if (req.method !== 'GET') throw new HttpError(405, `${req.method} is not supported here`);
    const { hosts } = this.options;
    if (url.pathname === hosts.path && isUpgrade(req.headers)) {
      return this.upgrade(conn, incoming, req, runtime);
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (path !== '/json/version' && path !== '/json/list' && path !== '/json') {
      throw new HttpError(404, 'not found: try /json/version');
    }
    if (!this.options.hosts.available(runtime)) {
      throw new HttpError(503, NO_CDP_HOST);
    }
    if (path === '/json/version') {
      await this.write(
        conn,
        json({
          Browser: 'slicc-kernel',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: `ws://${host}${hosts.path}${url.search}`,
        })
      );
      return;
    }
    await this.write(conn, json(await this.list(runtime)));
  }

  private async list(runtime: string | undefined): Promise<unknown[]> {
    const conn = await this.host(runtime);
    try {
      const reply = await new Promise<{ result?: { targetInfos?: TargetInfo[] }; error?: unknown }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new HttpError(504, 'the CDP host did not answer Target.getTargets')),
            this.options.listTimeout ?? LIST_TIMEOUT
          );
          conn.onclose = (reason) => {
            clearTimeout(timer);
            reject(new HttpError(502, `the CDP host closed: ${reason ?? 'no reason'}`));
          };
          conn.onmessage = (message) => {
            const parsed = JSON.parse(message) as { id?: number };
            if (parsed.id !== 1) return;
            clearTimeout(timer);
            resolve(parsed as never);
          };
          conn.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
        }
      );
      if (!reply.result) {
        throw new HttpError(502, `Target.getTargets failed: ${JSON.stringify(reply.error)}`);
      }
      return (reply.result.targetInfos ?? []).map((t) => ({
        description: '',
        id: t.targetId,
        title: t.title,
        type: t.type,
        url: t.url,
      }));
    } finally {
      conn.close();
    }
  }

  private host(runtime: string | undefined): Promise<CdpConnection> {
    return this.options.hosts.connect(runtime ? { runtime } : {});
  }

  private async upgrade(
    conn: KernelSocket,
    incoming: Incoming,
    req: RequestHead,
    runtime: string | undefined
  ): Promise<void> {
    const accept = await acceptKey(req.headers);
    const host = await this.host(runtime);
    await new Relay(conn, incoming, host, this.options.maxMessage ?? MAX_MESSAGE, this.stop.signal)
      .start(switchingHead(accept))
      .finally(() => host.close());
  }
}

class Relay {
  private writes: Promise<unknown> = Promise.resolve();
  private ended = false;

  private readonly conn: KernelSocket;
  private readonly incoming: Incoming;
  private readonly host: CdpConnection;
  private readonly max: number;
  private readonly stop: AbortSignal;

  constructor(
    conn: KernelSocket,
    incoming: Incoming,
    host: CdpConnection,
    max: number,
    stop: AbortSignal
  ) {
    this.conn = conn;
    this.incoming = incoming;
    this.host = host;
    this.max = max;
    this.stop = stop;
  }

  private send(bytes: Uint8Array): Promise<unknown> {
    this.writes = this.writes.then(() => this.conn.write(bytes, this.stop)).catch(() => undefined);
    return this.writes;
  }

  private end(code: number, reason: string): Promise<unknown> {
    if (this.ended) return this.writes;
    this.ended = true;
    return this.send(closeFrame(code, reason));
  }

  async start(head: Uint8Array): Promise<void> {
    await this.send(head);
    const hostGone = new Promise<void>((resolve) => {
      this.host.onclose = (reason) => {
        void this.end(reason ? CLOSE.error : CLOSE.normal, reason ?? '').then(() => resolve());
      };
    });
    this.host.onmessage = (message) => {
      if (this.ended) return;
      const bytes = new TextEncoder().encode(message);
      if (bytes.length > this.max)
        void this.end(CLOSE.tooBig, `a message is over ${this.max} bytes`);
      else void this.send(frame(OP_TEXT, bytes));
    };
    await Promise.race([this.pump(), hostGone]);
    await this.writes;
  }

  private async pump(): Promise<void> {
    const reader = new WsReader(this.incoming, this.max);
    try {
      for (;;) {
        const event = await reader.next(this.stop);
        if (!event) return;
        if (event.kind === 'text') this.host.send(event.text);
        else if (event.kind === 'ping') void this.send(pongFrame(event.payload));
        else {
          await this.end(event.code === 1005 ? CLOSE.normal : event.code, '');
          return;
        }
      }
    } catch (e) {
      if (e instanceof WsError) await this.end(e.code, e.message);
    }
  }
}

export function enableCdp(net: LoopbackNet, hosts: CdpHosts): () => CdpFacade | undefined {
  let facade: CdpFacade | undefined;
  net.kernelOnly(CDP_PORT, true);
  net.activate({ family: 'inet', host: '127.0.0.1', port: CDP_PORT }, () => {
    const started = new CdpFacade({ net, hosts });
    facade = started;
    void started.closed.then(() => {
      if (facade === started) facade = undefined;
    });
  });
  return () => facade;
}
