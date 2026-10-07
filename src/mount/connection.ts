import {
  DRIVER_PROTOCOL,
  type DriverCall,
  type DriverCapabilities,
  type DriverHello,
  type DriverReply,
  driverVersionError,
  type MountRequestInfo,
} from './protocol.ts';

export interface DriverPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start?(): void;
  close?(): void;
}

export interface ConnectionOptions {
  timeoutMs?: number;
  onInvalidate?: (paths: string[] | true) => void;
  onFail?: (error: Error) => void;
}

interface Waiting {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export const DRIVER_TIMEOUT_MS = 30_000;

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

export function errnoError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export class DriverConnection {
  readonly capabilities: DriverCapabilities;
  failure: Error | undefined;
  private readonly port: DriverPortLike;
  private readonly waiting: Map<number, Waiting>;
  private readonly timeoutMs: number;
  private nextId = 0;
  private readonly onFail: ((error: Error) => void) | undefined;

  private constructor(
    port: DriverPortLike,
    capabilities: DriverCapabilities,
    waiting: Map<number, Waiting>,
    timeoutMs: number,
    onFail: ((error: Error) => void) | undefined
  ) {
    this.port = port;
    this.capabilities = capabilities;
    this.waiting = waiting;
    this.timeoutMs = timeoutMs;
    this.onFail = onFail;
  }

  static async open(
    port: DriverPortLike,
    mount: MountRequestInfo,
    options: ConnectionOptions = {}
  ): Promise<DriverConnection> {
    const timeoutMs = options.timeoutMs ?? DRIVER_TIMEOUT_MS;
    const waiting = new Map<number, Waiting>();
    const greeted = Promise.withResolvers<DriverHello>();
    port.addEventListener('message', (event) => {
      const data = event.data as {
        hello?: DriverHello;
        invalidate?: string[] | true;
      } & DriverReply;
      if (data.hello) return greeted.resolve(data.hello);
      if (data.invalidate !== undefined) return options.onInvalidate?.(data.invalidate);
      const call = waiting.get(data.id);
      if (!call) return;
      waiting.delete(data.id);
      clearTimeout(call.timer);
      if (data.errno) call.reject(errnoError(data.errno, data.message ?? data.errno));
      else call.resolve(data.result);
    });
    port.start?.();
    port.postMessage({ hello: { protocol: DRIVER_PROTOCOL, mount } });
    const timer = unref(
      setTimeout(
        () => greeted.reject(errnoError('EIO', `the driver did not answer within ${timeoutMs} ms`)),
        timeoutMs
      )
    );
    let hello: DriverHello;
    try {
      hello = await greeted.promise;
    } finally {
      clearTimeout(timer);
    }
    const refused = driverVersionError(hello.protocol);
    if (refused) throw errnoError('EPROTO', refused);
    if (hello.error) throw errnoError(hello.errno ?? 'EIO', hello.error);
    return new DriverConnection(port, hello.capabilities ?? {}, waiting, timeoutMs, options.onFail);
  }

  call(call: DriverCall, transfer: Transferable[] = []): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = unref(
        setTimeout(() => {
          this.waiting.delete(id);
          const error = errnoError(
            'EIO',
            `the driver did not answer ${call.op} within ${this.timeoutMs} ms`
          );
          reject(error);
          this.fail(error);
          this.onFail?.(error);
        }, this.timeoutMs)
      );
      this.waiting.set(id, { resolve, reject, timer });
      this.port.postMessage({ ...call, id }, transfer);
    });
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const call of this.waiting.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.waiting.clear();
  }

  close(): void {
    this.fail(errnoError('EIO', 'the file system is unmounted'));
    this.port.close?.();
  }
}
