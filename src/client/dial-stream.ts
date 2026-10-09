export interface DialledSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}

export interface DialOptions {
  port: number;
  host?: string;
}

interface StreamPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

type DialMessage = Uint8Array | { end: true } | { error: string };

export function errorWithCode(message: string): Error & { code?: string } {
  const code = /^E[A-Z]+/.exec(message)?.[0];
  return Object.assign(new Error(message), code ? { code } : {});
}

export function dialStream(port: StreamPort): DialledSocket {
  let closed = false;
  let reader: ReadableStreamDefaultController<Uint8Array> | undefined;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = controller;
    },
    cancel() {
      reader = undefined;
      close();
    },
  });
  const finish = (fail?: Error) => {
    const controller = reader;
    reader = undefined;
    if (!controller) return;
    if (fail) controller.error(fail);
    else controller.close();
  };
  function close(): void {
    if (closed) return;
    closed = true;
    port.postMessage({ close: true });
    port.close();
    finish();
  }
  port.addEventListener('message', ({ data }: MessageEvent<DialMessage>) => {
    if (data instanceof Uint8Array) reader?.enqueue(data);
    else if ('end' in data) finish();
    else finish(errorWithCode(data.error));
  });
  port.start?.();
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (closed) throw errorWithCode('EPIPE: the connection is closed');
      const copy = chunk.slice();
      port.postMessage(copy, [copy.buffer]);
    },
    close() {
      if (!closed) port.postMessage({ end: true });
    },
    abort() {
      close();
    },
  });
  return { readable, writable, close };
}
