import { CDP_PORT } from '../cdp/types.ts';
import { KernelError } from '../kernel/fd-table.ts';
import { REALM_PROXY_PORT } from '../kernel/net/proxy-service.ts';
import type { ConnectorStamp, KernelSocket, LoopbackNet } from '../kernel/socket.ts';
import {
  FACADE_NAME,
  type FacadeConnection,
  type FacadeHook,
  type FacadeSpecs,
  facadeEnvName,
  facadeUrl,
} from './types.ts';

const TAKEN_PORTS = new Set([CDP_PORT, REALM_PROXY_PORT]);
const READ_CHUNK = 64 * 1024;

interface Declared {
  port: number;
  embedder: FacadeHook | undefined;
  clients: FacadeHook[];
}

function declared(specs: FacadeSpecs | undefined): Map<string, Declared> {
  const out = new Map<string, Declared>();
  const ports = new Set<number>();
  for (const [name, spec] of Object.entries(specs ?? {})) {
    if (!FACADE_NAME.test(name)) throw new TypeError(`facades: not a facade name: ${name}`);
    const port = spec?.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || TAKEN_PORTS.has(port)) {
      throw new TypeError(`facades.${name}: not a free port: ${String(port)}`);
    }
    if (ports.has(port)) throw new TypeError(`facades.${name}: port ${port} is taken twice`);
    if (spec.hook !== undefined && typeof spec.hook !== 'function') {
      throw new TypeError(`facades.${name}: hook must be a function`);
    }
    ports.add(port);
    out.set(name, { port, embedder: spec.hook, clients: [] });
  }
  return out;
}

export class FacadeHosts {
  private readonly facades: Map<string, Declared>;

  constructor(specs?: FacadeSpecs) {
    this.facades = declared(specs);
  }

  env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, { port }] of this.facades) env[facadeEnvName(name)] = facadeUrl(port);
    return env;
  }

  enable(net: LoopbackNet): void {
    for (const [name, { port }] of this.facades) {
      net.facade(port, name);
      net.activate({ family: 'inet', host: '127.0.0.1', port }, () => {
        const listener = net.listen({ family: 'inet', host: '127.0.0.1', port });
        void acceptAll(listener, (socket) => this.serve(name, socket));
      });
    }
  }

  register(name: string, hook: FacadeHook): () => void {
    const entry = this.facades.get(name);
    if (!entry || typeof hook !== 'function') throw new KernelError('EINVAL');
    entry.clients.push(hook);
    return () => {
      const at = entry.clients.indexOf(hook);
      if (at >= 0) entry.clients.splice(at, 1);
    };
  }

  private async serve(name: string, socket: KernelSocket): Promise<void> {
    const entry = this.facades.get(name) as Declared;
    const hook = entry.clients.at(-1) ?? entry.embedder;
    const stamp = socket.peerStamp;
    if (!hook || !stamp) return socket.close();
    let conn: FacadeConnection;
    try {
      conn = await hook(structuredClone(stamp) as ConnectorStamp, { name });
    } catch {
      return socket.close();
    }
    await relay(socket, conn);
  }
}

async function acceptAll(
  listener: KernelSocket,
  serve: (socket: KernelSocket) => Promise<void>
): Promise<void> {
  for (;;) {
    const socket = await listener.accept();
    void serve(socket);
  }
}

async function relay(socket: KernelSocket, conn: FacadeConnection): Promise<void> {
  let ended = false;
  let writes = Promise.resolve();
  const end = () => {
    if (ended) return;
    ended = true;
    socket.close();
  };
  conn.onmessage = (bytes) => {
    if (ended) return;
    const chunk = bytes.slice();
    writes = writes.then(async () => {
      if (ended) return;
      let at = 0;
      while (at < chunk.length) at += await socket.write(chunk.subarray(at));
    });
    writes.catch(() => {
      end();
      conn.close();
    });
  };
  conn.onclose = () => {
    writes.then(end, end);
  };
  try {
    for (;;) {
      const bytes = await socket.read(READ_CHUNK);
      if (bytes.length === 0 || ended) break;
      conn.send(bytes);
    }
  } catch {}
  if (!ended) {
    end();
    conn.close();
  }
}
