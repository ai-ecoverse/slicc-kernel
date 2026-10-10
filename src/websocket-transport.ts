import type {
  HeaderList,
  RealmWebSocket,
  RealmWebSocketMessage,
  RealmWebSocketRequest,
} from './kernel/net/transport.ts';
import { MessageQueue } from './kernel/net/ws-queue.ts';

export interface WebSocketLike {
  binaryType: string;
  readonly protocol: string;
  readonly bufferedAmount: number;
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export type WebSocketConstructor = new (url: string, init?: unknown) => WebSocketLike;

const SENT_HEADERS_DROP = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]);

function headerRecord(headers: HeaderList): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!SENT_HEADERS_DROP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

export function sendableClose(code?: number): number {
  return code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000;
}

function blockedReason(url: string, e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'SecurityError' && url.startsWith('ws:')) {
    return `${url}: ws:// is blocked from an https page; use wss:// or slicc-node`;
  }
  return `${url}: ${e instanceof Error ? e.message : String(e)}`;
}

export function openWebSocket(
  Socket: WebSocketConstructor,
  request: RealmWebSocketRequest,
  withHeaders: boolean
): Promise<RealmWebSocket> {
  const { url, protocols, signal } = request;
  signal.throwIfAborted();
  let socket: WebSocketLike;
  try {
    socket = withHeaders
      ? new Socket(url, { protocols, headers: headerRecord(request.headers) })
      : new Socket(url, protocols);
  } catch (e) {
    return Promise.reject(Object.assign(new Error(blockedReason(url, e)), { status: 502 }));
  }
  socket.binaryType = 'arraybuffer';
  const queue = new MessageQueue(() => socket.close(1000, 'too many waiting messages'));
  return new Promise((resolve, reject) => {
    let open = false;
    const abort = () => {
      socket.close(1000, 'aborted');
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => {
      open = true;
      signal.removeEventListener('abort', abort);
      resolve({
        protocol: socket.protocol,
        get buffered() {
          return socket.bufferedAmount;
        },
        send: (data: RealmWebSocketMessage) => socket.send(data),
        messages: queue,
        close: (code?: number, reason?: string) => socket.close(sendableClose(code), reason),
        closed: queue.closed,
      });
    });
    socket.addEventListener('message', (event: { data: string | ArrayBuffer }) => {
      queue.push(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
    });
    socket.addEventListener('close', (event: { code: number; reason: string }) => {
      queue.end({ code: event.code, reason: event.reason });
      if (open) return;
      signal.removeEventListener('abort', abort);
      reject(
        Object.assign(new Error(`${url}: the WebSocket closed (${event.code}) before it opened`), {
          status: 502,
        })
      );
    });
  });
}
