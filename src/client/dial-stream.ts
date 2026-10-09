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

type DialMessage = Uint8Array | { end: true } | { ack: true } | { error: string };

export interface DialHandle extends DialledSocket {
  fail(error: Error): void;
}

export function errorWithCode(message: string): Error & { code?: string } {
  const code = /^E[A-Z]+/.exec(message)?.[0];
  return Object.assign(new Error(message), code ? { code } : {});
}

export function dialStream(port: StreamPort, onClose?: () => void): DialHandle {
  let closed = false;
  let reader: ReadableStreamDefaultController<Uint8Array> | undefined;
  const acks: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = controller;
    },
    pull() {
      if (!closed) port.postMessage({ more: true });
    },
    cancel() {
      reader = undefined;
      close();
    },
  });
  const finish = (fail?: Error) => {
    const controller = reader;
    reader = undefined;
    for (const ack of acks.splice(0)) {
      if (fail) ack.reject(fail);
      else ack.resolve();
    }
    if (!controller) return;
    if (fail) controller.error(fail);
    else controller.close();
  };
  function shut(): void {
    if (closed) return;
    closed = true;
    port.close();
    onClose?.();
  }
  function close(): void {
    if (!closed) port.postMessage({ close: true });
    shut();
    finish();
  }
  port.addEventListener('message', ({ data }: MessageEvent<DialMessage>) => {
    if (data instanceof Uint8Array) reader?.enqueue(data);
    else if ('ack' in data) acks.shift()?.resolve();
    else if ('end' in data) finish();
    else finish(errorWithCode(data.error));
  });
  port.start?.();
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (closed) throw errorWithCode('EPIPE: the connection is closed');
      const copy = chunk.slice();
      const acked = new Promise<void>((resolve, reject) => acks.push({ resolve, reject }));
      port.postMessage(copy, [copy.buffer]);
      return acked;
    },
    close() {
      if (!closed) port.postMessage({ end: true });
    },
    abort() {
      close();
    },
  });
  const fail = (error: Error) => {
    shut();
    finish(error);
  };
  return { readable, writable, close, fail };
}
