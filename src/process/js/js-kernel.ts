import type { WasmSyscall } from '../../kernel/process.ts';
import { SIG, sigbit, signalsIn } from '../../kernel/signals.ts';
import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import {
  SAB_HEADER_I32,
  SAB_I_ASYNC,
  SAB_I_SIGNALS,
  type SyncSabRequestBody,
} from '../../realm/sync-sab-wire.ts';
import { type AsyncSabTransport, changed, type WaitAsyncLike } from './async-sab.ts';

export class JsCallError extends Error {
  readonly code: string;

  constructor(code: string, what: string) {
    super(`${what}: ${code}`);
    this.name = 'JsCallError';
    this.code = code;
  }
}

export type SignalHandler = (signal: number) => unknown;

export interface JsKernelOptions {
  sab: SharedArrayBuffer;
  transport: AsyncSabTransport;
  waitAsync: WaitAsyncLike | undefined;
  onError: (err: unknown) => void;
}

export class JsKernel {
  private readonly header: Int32Array;
  private readonly transport: AsyncSabTransport;
  private readonly waitAsync: WaitAsyncLike | undefined;
  private readonly onError: (err: unknown) => void;
  private readonly handlers = new Map<number, SignalHandler>();
  private ignored = 0;
  private reported = { caught: 0, ignored: 0 };
  private watching = false;

  constructor(o: JsKernelOptions) {
    this.header = new Int32Array(o.sab, 0, SAB_HEADER_I32);
    this.transport = o.transport;
    this.waitAsync = o.waitAsync;
    this.onError = o.onError;
  }

  async raw(req: SyncSabRequestBody): Promise<SyncFsResult> {
    const result = await this.transport.call(req);
    this.deliver();
    return result;
  }

  async call(req: SyncSabRequestBody): Promise<SyncFsResult> {
    const result = await this.raw(req);
    if (!result.ok) throw new JsCallError(result.errno, req.op);
    return result;
  }

  async json(req: SyncSabRequestBody): Promise<unknown> {
    const result = await this.call(req);
    return result.ok && result.kind === 'json' ? result.json : undefined;
  }

  async bytes(req: SyncSabRequestBody): Promise<Uint8Array> {
    const result = await this.call(req);
    return result.ok && result.kind === 'bytes' ? result.bytes : new Uint8Array(0);
  }

  async blocking(req: WasmSyscall): Promise<SyncFsResult> {
    for (;;) {
      const id = (await this.json({ op: 'async-submit', req })) as number;
      const result = await this.settled(id);
      if (result.ok) return result;
      if (result.errno !== 'EINTR') throw new JsCallError(result.errno, req.op);
    }
  }

  private async settled(id: number): Promise<SyncFsResult> {
    for (;;) {
      const seen = Atomics.load(this.header, SAB_I_ASYNC);
      const taken = await this.raw({ op: 'async-take', id });
      if (taken.ok || taken.errno !== 'EAGAIN') return taken;
      await changed(this.header, SAB_I_ASYNC, seen, this.waitAsync);
    }
  }

  deliver(): void {
    const pending = Atomics.exchange(this.header, SAB_I_SIGNALS, 0);
    for (const sig of signalsIn(pending)) {
      const handler = this.handlers.get(sig);
      if (!handler) continue;
      try {
        Promise.resolve(handler(sig)).catch(this.onError);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  async watch(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    for (;;) {
      await changed(this.header, SAB_I_SIGNALS, 0, this.waitAsync);
      this.deliver();
    }
  }

  async setHandler(sig: number, handler: SignalHandler | 'ignore' | 'default'): Promise<void> {
    if (sig === SIG.KILL || sig === SIG.STOP) throw new JsCallError('EINVAL', 'signal');
    this.handlers.delete(sig);
    this.ignored &= ~sigbit(sig);
    if (handler === 'ignore') this.ignored |= sigbit(sig);
    else if (handler !== 'default') this.handlers.set(sig, handler);
    await this.report();
    if (this.handlers.size > 0) void this.watch();
  }

  handles(sig: number): boolean {
    return this.handlers.has(sig) || (this.ignored & sigbit(sig)) !== 0;
  }

  private async report(): Promise<void> {
    let caught = 0;
    for (const sig of this.handlers.keys()) caught |= sigbit(sig);
    const { ignored } = this;
    if (caught === this.reported.caught && ignored === this.reported.ignored) return;
    this.reported = { caught, ignored };
    await this.call({ op: 'sig-mask', caught, ignored });
  }
}
