import { JsCallError, type JsKernel } from './js-kernel.ts';

export type JsWebSocketMessage = string | Uint8Array;

export interface JsWebSocketClose {
  code: number;
  reason: string;
}

export interface JsWebSocketOptions {
  protocols?: string | string[];
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface JsWebSocket {
  readonly url: string;
  readonly protocol: string;
  readonly readable: ReadableStream<JsWebSocketMessage>;
  readonly writable: WritableStream<JsWebSocketMessage>;
  readonly closed: Promise<JsWebSocketClose>;
  close(close?: Partial<JsWebSocketClose>): void;
}

const SEND_BUFFER = 1024 * 1024;
const MAX_REASON = 123;
const NEVER = new AbortController().signal;

function failed(err: unknown): TypeError {
  return new TypeError('websocket failed', { cause: err });
}

function socketUrl(input: string | URL): string {
  const url = new URL(input);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new SyntaxError(`not a WebSocket URL: ${url.href}`);
  }
  url.hash = '';
  return url.href;
}

function closeCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  throw new JsCallError('EINVAL', `close code ${code}`);
}

function closeReason(reason: string | undefined): string {
  if (reason === undefined) return '';
  if (new TextEncoder().encode(reason).length > MAX_REASON) {
    throw new JsCallError('EINVAL', `close reason over ${MAX_REASON} bytes`);
  }
  return reason;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function websocketOp(kernel: JsKernel) {
  return async (input: string | URL, options: JsWebSocketOptions = {}): Promise<JsWebSocket> => {
    const url = socketUrl(input);
    const signal = options.signal ?? NEVER;
    signal.throwIfAborted();
    const protocols =
      typeof options.protocols === 'string' ? [options.protocols] : (options.protocols ?? []);
    const handle = (await kernel.json({
      op: 'net-ws-open',
      url,
      protocols,
      headers: [...new Headers(options.headers)],
    })) as number;
    const free = () => kernel.raw({ op: 'net-close', handle });
    let protocol: string;
    try {
      const r = await kernel.blocking({ op: 'net-ws-ready', handle }, signal);
      protocol = ((r.ok && r.kind === 'json' ? r.json : {}) as { protocol: string }).protocol;
    } catch (err) {
      await free();
      throw signal.aborted ? signal.reason : failed(err);
    }

    let settle!: (close: JsWebSocketClose) => void;
    let lose!: (err: unknown) => void;
    const closed = new Promise<JsWebSocketClose>((resolve, reject) => {
      settle = resolve;
      lose = reject;
    });
    closed.catch(() => undefined);
    const stop = new AbortController();
    let freed = false;
    const hardStop = (reason: unknown): void => {
      if (stop.signal.aborted) return;
      stop.abort(reason);
      lose(reason);
      freed = true;
      void free();
    };
    signal.addEventListener('abort', () => hardStop(signal.reason), { once: true });
    let settled = false;
    let readDone = false;
    const release = (): void => {
      if (!settled || !readDone || freed) return;
      freed = true;
      void free();
    };
    kernel
      .blocking({ op: 'net-ws-wait', handle }, stop.signal)
      .then((r) => {
        settled = true;
        settle((r as Extract<typeof r, { kind: 'json' }>).json as JsWebSocketClose);
        release();
      })
      .catch(lose);
    const close = (how: Partial<JsWebSocketClose> = {}): void => {
      void kernel.raw({
        op: 'net-ws-close',
        handle,
        code: closeCode(how.code),
        reason: closeReason(how.reason),
      });
    };

    const readable = new ReadableStream<JsWebSocketMessage>(
      {
        async pull(controller) {
          let r: Awaited<ReturnType<JsKernel['blocking']>>;
          try {
            r = await kernel.blocking({ op: 'net-ws-recv', handle }, stop.signal);
          } catch (err) {
            hardStop(stop.signal.aborted ? stop.signal.reason : failed(err));
            throw stop.signal.reason;
          }
          stop.signal.throwIfAborted();
          if (r.ok && r.kind === 'bytes') {
            controller.enqueue(r.bytes);
            return;
          }
          const text = ((r.ok && r.kind === 'json' ? r.json : {}) as { text?: string }).text;
          if (text !== undefined) {
            controller.enqueue(text);
            return;
          }
          controller.close();
          readDone = true;
          release();
        },
        cancel: () => {
          close();
          readDone = true;
          release();
        },
      },
      { highWaterMark: 0 }
    );

    const writable = new WritableStream<JsWebSocketMessage>({
      async write(chunk) {
        stop.signal.throwIfAborted();
        const body = typeof chunk === 'string' ? { text: chunk } : { body: chunk };
        let buffered = (await kernel.json({ op: 'net-ws-send', handle, ...body })) as number;
        while (buffered > SEND_BUFFER && !stop.signal.aborted) {
          await wait(10);
          buffered = (await kernel.json({ op: 'net-ws-send', handle })) as number;
        }
      },
      close: () => close(),
      abort: () => close({ code: 1000, reason: '' }),
    });

    return { url, protocol, readable, writable, closed, close };
  };
}
