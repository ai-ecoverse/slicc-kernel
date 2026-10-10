import { E } from '../wasi/wasi-abi.ts';
import { JsCallError, type JsKernel } from './js-kernel.ts';

export interface JsAddress {
  host: string;
  port: number;
}

export interface JsConnection {
  readonly fd: number;
  readonly local: JsAddress;
  readonly remote: JsAddress;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface JsListener extends AsyncIterable<JsConnection> {
  readonly fd: number;
  readonly host: string;
  readonly port: number;
  accept(options?: { signal?: AbortSignal }): Promise<JsConnection>;
  close(): Promise<void>;
}

export interface JsListenOptions {
  port?: number;
  host?: string;
  backlog?: number;
}

export interface JsConnectOptions {
  host: string;
  port: number;
  signal?: AbortSignal;
}

export interface JsNet {
  listen(options?: JsListenOptions): Promise<JsListener>;
  connect(options: JsConnectOptions): Promise<JsConnection>;
}

export interface NetIo {
  read(fd: number, max: number | undefined, signal: AbortSignal): Promise<Uint8Array>;
  send(fd: number, data: Uint8Array, signal: AbortSignal): Promise<void>;
  close(fd: number): Promise<void>;
}

interface InetAddr {
  family: 'inet';
  host: string;
  port: number;
}

const SHUT_RD = 0;
const SHUT_WR = 1;
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const NEVER = new AbortController().signal;
const SOL_SOCKET = 1;
const SO_ERROR = 4;

function errnoName(errno: number): string {
  const found = Object.entries(E).find(([, n]) => n === errno);
  return found ? `E${found[0]}` : 'EIO';
}

function addressOf(addr: unknown): JsAddress {
  const inet = addr as InetAddr;
  return { host: inet.host, port: inet.port };
}

function port(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new JsCallError('EINVAL', `port ${n}`);
  return n;
}

export function netOps(kernel: JsKernel, io: NetIo): JsNet {
  const name = async (fd: number, peer: boolean): Promise<JsAddress> =>
    addressOf(await kernel.json({ op: 'sock-name', fd, peer }));

  const connection = async (fd: number): Promise<JsConnection> => {
    const [local, remote] = [await name(fd, false), await name(fd, true)];
    const stop = new AbortController();
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
      stop.abort(new JsCallError('EBADF', 'socket closed'));
      closed ??= io.close(fd);
      return closed;
    };
    const shut = (how: number): Promise<unknown> => kernel.raw({ op: 'sock-shutdown', fd, how });
    const readable = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const chunk = await io.read(fd, undefined, stop.signal);
          if (chunk.length > 0) controller.enqueue(chunk);
          else controller.close();
        },
        cancel: async () => void (await shut(SHUT_RD)),
      },
      { highWaterMark: 0 }
    );
    const writable = new WritableStream<Uint8Array>({
      write: (chunk, controller) =>
        io.send(fd, chunk, AbortSignal.any([controller.signal, stop.signal])),
      close: async () => void (await shut(SHUT_WR)),
      abort: () => close(),
    });
    return { fd, local, remote, readable, writable, close };
  };

  const resolve = async (host: string, signal: AbortSignal): Promise<string> => {
    if (IPV4.test(host)) return host;
    const r = await kernel.blocking({ op: 'sock-resolve', name: host, family: 4 }, signal);
    return ((r.ok && r.kind === 'json' ? r.json : []) as string[])[0] as string;
  };

  const opened = async <T>(use: (fd: number) => Promise<T>): Promise<T> => {
    const fd = (await kernel.json({ op: 'sock-open', domain: 'inet' })) as number;
    try {
      return await use(fd);
    } catch (err) {
      await io.close(fd);
      throw err;
    }
  };

  const listener = (fd: number, at: JsAddress): JsListener => {
    const stop = new AbortController();
    const accept = async (options: { signal?: AbortSignal } = {}): Promise<JsConnection> => {
      const signal = AbortSignal.any([options.signal ?? NEVER, stop.signal]);
      for (;;) {
        signal.throwIfAborted();
        const r = await kernel.raw({ op: 'sock-accept', fd, nonblock: true });
        if (r.ok) return connection(((r.kind === 'json' ? r.json : {}) as { fd: number }).fd);
        if (r.errno !== 'EAGAIN') throw new JsCallError(r.errno, 'accept');
        await kernel.blocking({ op: 'fd-select', read: [fd], write: [], timeoutMs: -1 }, signal);
      }
    };
    return {
      fd,
      ...at,
      accept,
      async close() {
        stop.abort(new JsCallError('EBADF', 'listener closed'));
        await io.close(fd);
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          try {
            yield await accept();
          } catch (err) {
            if (stop.signal.aborted) return;
            throw err;
          }
        }
      },
    };
  };

  return {
    listen: (options = {}) =>
      opened(async (fd) => {
        const addr: InetAddr = {
          family: 'inet',
          host: options.host ?? '127.0.0.1',
          port: port(options.port ?? 0),
        };
        await kernel.call({ op: 'sock-bind', fd, addr });
        await kernel.call({ op: 'sock-listen', fd, backlog: options.backlog ?? 128 });
        return listener(fd, await name(fd, false));
      }),
    connect: async (options) => {
      const signal = options.signal ?? NEVER;
      signal.throwIfAborted();
      const addr: InetAddr = {
        family: 'inet',
        host: await resolve(options.host, signal),
        port: port(options.port),
      };
      return opened(async (fd) => {
        const r = await kernel.raw({ op: 'sock-connect', fd, addr, nonblock: true });
        if (!r.ok && r.errno !== 'EINPROGRESS') throw new JsCallError(r.errno, 'connect');
        await kernel.blocking({ op: 'fd-select', read: [], write: [fd], timeoutMs: -1 }, signal);
        const failed = (await kernel.json({
          op: 'sock-getopt',
          fd,
          level: SOL_SOCKET,
          name: SO_ERROR,
        })) as number;
        if (failed !== 0) throw new JsCallError(errnoName(failed), 'connect');
        return connection(fd);
      });
    },
  };
}
