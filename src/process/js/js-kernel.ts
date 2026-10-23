import type { WasmSyscall } from '../../kernel/process.ts';
import { type DefaultAction, defaultAction, SIG, sigbit, signalsIn } from '../../kernel/signals.ts';
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

  readonly detail: string | undefined;

  constructor(code: string, what: string, detail?: string) {
    super(`${what}: ${code}`);
    this.name = 'JsCallError';
    this.code = code;
    this.detail = detail;
  }
}

const DETAILED: ReadonlySet<string> = new Set([
  'fd-read',
  'fd-write',
  'fd-close',
  'fd-open-clipboard',
  'fd-open-embedder',
  'net-ws-ready',
  'sock-tls',
  'sock-tls-upgrade',
  'sock-tls-serve',
  'sock-tls-listen',
  'sock-tls-context',
  'sock-tls-select',
]);

export function umaskRequest(mask: unknown): { op: 'proc-umask'; mask?: number } {
  if (mask === undefined) return { op: 'proc-umask' };
  if (!Number.isInteger(mask) || (mask as number) < 0 || (mask as number) > 0o777) {
    throw new JsCallError('EINVAL', 'umask');
  }
  return { op: 'proc-umask', mask: mask as number };
}

export function modeOf(mode: unknown): number {
  if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777) {
    throw new JsCallError('EINVAL', 'chmod');
  }
  return mode as number;
}

export function callError(result: { errno: string; message: string }, op: string): JsCallError {
  const { errno, message } = result;
  const detailed = typeof message === 'string' && message !== errno && DETAILED.has(op);
  return new JsCallError(
    errno,
    detailed ? `${op}: ${message}` : op,
    detailed ? message : undefined
  );
}

function untilAborted(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return work;
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    work.then(done, done);
  });
}

export type SignalHandler = (signal: number) => unknown;

export interface JsKernelOptions {
  sab: SharedArrayBuffer;
  transport: AsyncSabTransport;
  waitAsync: WaitAsyncLike | undefined;
  onError: (err: unknown) => void;
}

function caughtOf(handlers: Map<number, SignalHandler>): number {
  let caught = 0;
  for (const sig of handlers.keys()) caught |= sigbit(sig);
  return caught;
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
  faulted = false;
  syncLane: ((req: SyncSabRequestBody) => SyncFsResult) | undefined;

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
    if (!result.ok) throw callError(result, req.op);
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

  async blocking(
    req: WasmSyscall,
    signal?: AbortSignal,
    track?: (id: number) => void
  ): Promise<SyncFsResult> {
    for (;;) {
      const id = await this.submit(req, track);
      const result = await this.settled(id, signal);
      if (result.ok) return result;
      if (result.errno !== 'EINTR') throw callError(result, req.op);
    }
  }

  private acks: number[] = [];

  ack(id: number): void {
    this.acks.push(id);
  }

  private async submit(req: WasmSyscall, track?: (id: number) => void): Promise<number> {
    const ack = this.acks;
    this.acks = [];
    const r = await this.transport.call({
      op: 'async-submit',
      req,
      ...(ack.length > 0 ? { ack } : {}),
    });
    const id = r.ok && r.kind === 'json' ? (r.json as number) : undefined;
    if (id !== undefined) track?.(id);
    this.deliver();
    if (id === undefined) throw new JsCallError(r.ok ? 'EIO' : r.errno, 'async-submit');
    return id;
  }

  private async settled(id: number, signal?: AbortSignal): Promise<SyncFsResult> {
    for (;;) {
      const seen = Atomics.load(this.header, SAB_I_ASYNC);
      const taken = await this.raw({ op: 'async-take', id });
      if (taken.ok || taken.errno !== 'EAGAIN') return taken;
      if (signal?.aborted) {
        await this.raw({ op: 'async-cancel', id });
        throw signal.reason;
      }
      await untilAborted(changed(this.header, SAB_I_ASYNC, seen, this.waitAsync), signal);
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
        Promise.resolve(handler(sig)).catch((err) => this.fault(err));
      } catch (err) {
        this.fault(err);
      }
    }
  }

  private fault(err: unknown): void {
    this.faulted = true;
    this.onError(err);
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

  disposition(sig: number): 'caught' | 'ignored' | DefaultAction {
    if (this.handlers.has(sig)) return 'caught';
    if (this.ignored & sigbit(sig)) return 'ignored';
    return defaultAction(sig);
  }

  setHandler(sig: number, handler: SignalHandler | 'ignore' | 'default'): Promise<void> {
    if (sig === SIG.KILL || sig === SIG.STOP) {
      return Promise.reject(new JsCallError('EINVAL', 'signal'));
    }
    if (this.syncLane) {
      try {
        this.changeNow(this.syncLane, sig, handler);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const run = this.changing.then(() => this.change(sig, handler));
    this.changing = run.catch(() => undefined);
    return run;
  }

  private changeNow(
    lane: (req: SyncSabRequestBody) => SyncFsResult,
    sig: number,
    handler: SignalHandler | 'ignore' | 'default'
  ): void {
    const { handlers, ignored } = this.disposed(sig, handler);
    const defaults = handler === 'default' ? sigbit(sig) : 0;
    const caught = caughtOf(handlers);
    if (caught !== this.reported.caught || ignored !== this.reported.ignored || defaults !== 0) {
      const r = lane({ op: 'sig-mask', caught, ignored, ...(defaults ? { defaults } : {}) });
      if (!r.ok) throw new JsCallError(r.errno, 'sig-mask');
      this.reported = { caught, ignored };
    }
    this.handlers = handlers;
    this.ignored = ignored;
    if (handlers.size > 0) void this.watch();
  }

  private disposed(
    sig: number,
    handler: SignalHandler | 'ignore' | 'default'
  ): { handlers: Map<number, SignalHandler>; ignored: number } {
    const handlers = new Map(this.handlers);
    handlers.delete(sig);
    let ignored = this.ignored & ~sigbit(sig);
    if (handler === 'ignore') ignored |= sigbit(sig);
    else if (handler !== 'default') handlers.set(sig, handler);
    return { handlers, ignored };
  }

  private async change(sig: number, handler: SignalHandler | 'ignore' | 'default'): Promise<void> {
    const { handlers, ignored } = this.disposed(sig, handler);
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
    const caught = caughtOf(handlers);
    const same = caught === this.reported.caught && ignored === this.reported.ignored;
    if (same && defaults === 0) return;
    this.reported = { caught, ignored };
    await this.call({ op: 'sig-mask', caught, ignored, ...(defaults ? { defaults } : {}) });
  }
}
