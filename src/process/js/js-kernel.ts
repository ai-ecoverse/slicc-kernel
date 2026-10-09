import type { WasmSyscall } from '../../kernel/process.ts';
import { SIG, sigbit, signalsIn } from '../../kernel/signals.ts';
import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import {
  SAB_HEADER_I32,
  SAB_I_ASYNC,
  SAB_I_SIGNALS,
  SAB_I_STOP,
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
  private handlers = new Map<number, SignalHandler>();
  private ignored = 0;
  private changing: Promise<unknown> = Promise.resolve();
  pid = 0;
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
      if (!handler) {
        if (!(this.ignored & sigbit(sig))) this.raise(sig);
        continue;
      }
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

  async watchStops(): Promise<void> {
    for (;;) {
      await changed(this.header, SAB_I_STOP, 0, this.waitAsync);
      this.freeze();
    }
  }

  freeze(): void {
    while (Atomics.load(this.header, SAB_I_STOP) === 1) Atomics.wait(this.header, SAB_I_STOP, 1);
  }

  setHandler(sig: number, handler: SignalHandler | 'ignore' | 'default'): Promise<void> {
    if (sig === SIG.KILL || sig === SIG.STOP) {
      return Promise.reject(new JsCallError('EINVAL', 'signal'));
    }
    const run = this.changing.then(() => this.change(sig, handler));
    this.changing = run.catch(() => undefined);
    return run;
  }

  private async change(sig: number, handler: SignalHandler | 'ignore' | 'default'): Promise<void> {
    const handlers = new Map(this.handlers);
    handlers.delete(sig);
    let ignored = this.ignored & ~sigbit(sig);
    if (handler === 'ignore') ignored |= sigbit(sig);
    else if (handler !== 'default') handlers.set(sig, handler);
    await this.report(handlers, ignored, handler === 'default' ? sigbit(sig) : 0);
    this.handlers = handlers;
    this.ignored = ignored;
    if (handlers.size > 0) void this.watch();
  }

  private raise(sig: number): void {
    this.call({ op: 'proc-kill', pid: this.pid, sig }).catch(this.onError);
  }

  private async report(
    handlers: Map<number, SignalHandler>,
    ignored: number,
    defaults: number
  ): Promise<void> {
    let caught = 0;
    for (const sig of handlers.keys()) caught |= sigbit(sig);
    const same = caught === this.reported.caught && ignored === this.reported.ignored;
    if (same && defaults === 0) return;
    this.reported = { caught, ignored };
    await this.call({ op: 'sig-mask', caught, ignored, ...(defaults ? { defaults } : {}) });
  }
}
