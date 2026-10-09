import { KernelError } from './fd-table.ts';
import { type KernelSocket, type LoopbackNet, SHUT_WR } from './socket.ts';

export interface DialPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

export type DialMessage =
  | Uint8Array
  | { end: true }
  | { close: true }
  | { more: true }
  | { ack: true }
  | { error: string };

const CHUNK = 64 * 1024;

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function dialSocket(net: LoopbackNet, port: number, host = '127.0.0.1'): KernelSocket {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new KernelError('EINVAL');
  const target = LOOPBACK_NAMES.has(host.toLowerCase()) ? '127.0.0.1' : host;
  return net.connect({ family: 'inet', host: target, port });
}

const codeOf = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'EIO';
};

export function serveSocket(
  socket: KernelSocket,
  port: DialPortLike,
  onClose?: () => void
): () => void {
  let closed = false;
  let writes = Promise.resolve();
  let credit = 0;
  let granted: (() => void) | undefined;
  const send = (message: DialMessage, transfer?: Transferable[]) => {
    if (!closed) port.postMessage(message, transfer);
  };
  const close = (reset = false) => {
    if (closed) return;
    if (reset) send({ error: 'ECONNRESET' });
    closed = true;
    granted?.();
    socket.close();
    port.close();
    onClose?.();
  };
  const write = (data: Uint8Array) => {
    writes = writes.then(async () => {
      if (closed) return;
      try {
        await socket.write(data);
        send({ ack: true });
      } catch (err) {
        send({ error: codeOf(err) });
      }
    });
  };
  port.addEventListener('message', ({ data }: MessageEvent<DialMessage>) => {
    if (data instanceof Uint8Array) write(data);
    else if ('more' in data) {
      credit++;
      granted?.();
    } else if ('end' in data) {
      writes = writes.then(() => {
        if (!closed) socket.shutdown(SHUT_WR);
      });
    } else if ('close' in data) close();
  });
  port.start?.();
  const turn = () =>
    credit > 0 || closed ? Promise.resolve() : new Promise<void>((r) => (granted = r));
  void (async () => {
    try {
      for (;;) {
        await turn();
        if (closed) return;
        const chunk = await socket.read(CHUNK);
        if (chunk.length === 0) break;
        credit--;
        send(chunk, [chunk.buffer as ArrayBuffer]);
      }
      send({ end: true });
    } catch (err) {
      send({ error: codeOf(err) });
    }
  })();
  return () => close(true);
}
