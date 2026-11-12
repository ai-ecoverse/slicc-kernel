import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import { syncError } from '../realm/sync-fs-wire.ts';
import {
  decodeSabResult,
  SAB_CLOCK_I64,
  SAB_CLOCK_OFFSET,
  SAB_HEADER_BYTES,
  SAB_HEADER_I32,
  SAB_I_ASYNC,
  SAB_I_BLOCKED,
  SAB_I_BLOCKED_HI,
  SAB_I_KILLED,
  SAB_I_MEMORY,
  SAB_I_SIGNALS,
  SAB_I_STOP,
  SAB_I_TIMERS,
  SAB_STATUS_BYTES,
  type SyncSabRequestBody,
} from '../realm/sync-sab-wire.ts';
import type { KernelLink } from './link.ts';
import type { ForkSnapshots } from './snapshots.ts';
import {
  ASYNC_MIRROR,
  ASYNC_MORE,
  ASYNC_SNAPSHOT,
  ASYNC_SNAPSHOT_TAKEN,
  ASYNC_STAGE,
  ASYNC_SYSCALL,
  ASYNC_WORDS,
  type AsyncAnswer,
  type AsyncMoreReply,
  type AsyncProcessInit,
  type AsyncSnapshotReply,
  type AsyncSyscallMsg,
  type AsyncSyscallReply,
  applyRuns,
  type MirroredBuffer,
  type MirrorUpdate,
  type ProcessWords,
  type StagedBytes,
} from './wire.ts';

export type WaitResult = 'ok' | 'not-equal' | 'timed-out';

export interface AsyncTransport {
  readonly init: Promise<AsyncProcessInit>;
  readonly buffer: ArrayBuffer;
  readonly header: Int32Array;
  readonly clock: BigInt64Array;
  readonly changes: ArrayBuffer | undefined;
  readonly cwds: ArrayBuffer | undefined;
  readonly closed: boolean;
  call(
    req: SyncSabRequestBody,
    timeoutMs: number,
    label: string,
    transfer?: Transferable[],
    sink?: Uint8Array
  ): Promise<SyncFsResult>;
  wait(view: Int32Array, index: number, value: number, timeoutMs?: number): Promise<WaitResult>;
  notify(view: Int32Array, index: number): void;
  publish(): void;
  post(message: unknown, transfer?: Transferable[]): void;
  onClose(handler: (reason: string) => void): void;
}

export interface AsyncTransportOptions {
  maxMessageBytes?: number;
  memory?: () => number | undefined;
  snapshots?: ForkSnapshots;
}

interface ForkRequest {
  op?: unknown;
  state?: { memory?: unknown };
}

function snapshotted(
  asked: SyncSabRequestBody,
  snapshots: ForkSnapshots | undefined
): { req: SyncSabRequestBody; token?: string } {
  const fork = asked as ForkRequest;
  const memory = fork.state?.memory;
  if (!snapshots || fork.op !== 'proc-fork' || !(memory instanceof Uint8Array)) {
    return { req: asked };
  }
  if (memory.byteLength === 0) return { req: asked };
  const owned = memory.buffer instanceof ArrayBuffer ? memory : memory.slice();
  const snapshot = snapshots.keep(owned);
  const state = { ...fork.state, memory: new Uint8Array(0), snapshot };
  const req = { ...asked, state } as unknown as SyncSabRequestBody;
  return { req, token: snapshot.token };
}

interface Waiter {
  view: Int32Array;
  index: number;
  value: number;
  settle: (result: WaitResult) => void;
  fail: (err: Error) => void;
}

const CLOCK_BLOCKED = 0;
const CLOCK_IDLE = 1;

function isAnswer(reply: AsyncSyscallReply): reply is AsyncAnswer {
  return typeof (reply as AsyncAnswer).status === 'number';
}

function bodyOf(req: SyncSabRequestBody): Uint8Array | undefined {
  const body = (req as { body?: unknown }).body;
  return body instanceof Uint8Array ? body : undefined;
}

function exactCopy(body: Uint8Array): { body: Uint8Array; transfer: Transferable[] } {
  const whole = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength;
  if (whole && body.buffer instanceof ArrayBuffer) return { body, transfer: [] };
  const copy = body.slice();
  return { body: copy, transfer: [copy.buffer] };
}

function landing(status: number, total: number, sink: Uint8Array | undefined): Uint8Array {
  if (!sink || status !== SAB_STATUS_BYTES || total > sink.length) return new Uint8Array(total);
  return new Uint8Array(sink.buffer, sink.byteOffset, total);
}

function mirrored(spec: MirroredBuffer | undefined): ArrayBuffer | undefined {
  if (!spec) return undefined;
  const buffer = new ArrayBuffer(spec.bytes);
  applyRuns(new Int32Array(buffer), spec.runs);
  return buffer;
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms)) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(syncError('EIO', label)), Math.max(0, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

class Mirrors {
  readonly buffer = new ArrayBuffer(SAB_HEADER_BYTES);
  readonly header = new Int32Array(this.buffer, 0, SAB_HEADER_I32);
  readonly clock = new BigInt64Array(this.buffer, SAB_CLOCK_OFFSET, SAB_CLOCK_I64);
  changes: ArrayBuffer | undefined;
  cwds: ArrayBuffer | undefined;
  private changesView: Int32Array | undefined;
  private cwdsView: Int32Array | undefined;
  applied = 0;
  private readonly early = new Map<number, MirrorUpdate>();
  private readonly settled = new Map<number, Array<() => void>>();
  readonly waiters = new Set<Waiter>();

  start(mirror: AsyncProcessInit['mirror']): void {
    this.header.set(mirror.header.subarray(0, SAB_HEADER_I32));
    Atomics.store(this.clock, CLOCK_BLOCKED, BigInt(mirror.clock[0]));
    Atomics.store(this.clock, CLOCK_IDLE, BigInt(mirror.clock[1]));
    this.changes = mirrored(mirror.changes);
    this.cwds = mirrored(mirror.cwds);
    this.changesView = this.changes ? new Int32Array(this.changes) : undefined;
    this.cwdsView = this.cwds ? new Int32Array(this.cwds) : undefined;
  }

  private apply(m: MirrorUpdate): void {
    const { header } = this;
    if (m.signals) Atomics.or(header, SAB_I_SIGNALS, m.signals);
    if (m.timers) Atomics.or(header, SAB_I_TIMERS, m.timers);
    Atomics.store(header, SAB_I_KILLED, m.killed);
    Atomics.store(header, SAB_I_ASYNC, m.async);
    Atomics.store(header, SAB_I_STOP, m.stop);
    Atomics.store(this.clock, CLOCK_BLOCKED, BigInt(m.clock));
    if (this.changesView) applyRuns(this.changesView, m.changes);
    if (this.cwdsView) applyRuns(this.cwdsView, m.cwds);
    this.applied = m.seq;
  }

  accept(m: MirrorUpdate): Promise<void> {
    if (m.seq <= this.applied) return Promise.resolve();
    this.early.set(m.seq, m);
    const done = new Promise<void>((resolve) => {
      const list = this.settled.get(m.seq) ?? [];
      list.push(resolve);
      this.settled.set(m.seq, list);
    });
    let progressed = false;
    for (
      let next = this.early.get(this.applied + 1);
      next;
      next = this.early.get(this.applied + 1)
    ) {
      this.early.delete(next.seq);
      this.apply(next);
      progressed = true;
      for (const resolve of this.settled.get(next.seq) ?? []) resolve();
      this.settled.delete(next.seq);
    }
    if (progressed) this.wake();
    return done;
  }

  wake(): void {
    for (const waiter of [...this.waiters]) {
      if (Atomics.load(waiter.view, waiter.index) === waiter.value) continue;
      this.waiters.delete(waiter);
      waiter.settle('ok');
    }
  }

  notify(view: Int32Array, index: number): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.view !== view || waiter.index !== index) continue;
      this.waiters.delete(waiter);
      waiter.settle('ok');
    }
  }

  failAll(err: Error): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.fail(err);
    }
  }

  words(n: number, memory: number | undefined): ProcessWords {
    const { header } = this;
    if (memory !== undefined && memory > 0) {
      Atomics.store(header, SAB_I_MEMORY, Math.ceil(memory / 65536));
    }
    return {
      n,
      seen: this.applied,
      signals: Atomics.load(header, SAB_I_SIGNALS),
      timers: Atomics.load(header, SAB_I_TIMERS),
      blocked: [Atomics.load(header, SAB_I_BLOCKED), Atomics.load(header, SAB_I_BLOCKED_HI)],
      memory: Atomics.load(header, SAB_I_MEMORY),
      idle: Number(Atomics.load(this.clock, CLOCK_IDLE)),
    };
  }

  wait(view: Int32Array, index: number, value: number, timeoutMs: number): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        view,
        index,
        value,
        settle: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        fail: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.waiters.add(waiter);
      if (!Number.isFinite(timeoutMs)) return;
      timer = setTimeout(
        () => {
          this.waiters.delete(waiter);
          resolve('timed-out');
        },
        Math.max(0, timeoutMs)
      );
    });
  }
}

class Caller {
  private readonly link: KernelLink;
  max: number;
  private stages = 0;

  constructor(link: KernelLink, max: number) {
    this.link = link;
    this.max = max;
  }

  async pull(part: number, out: Uint8Array, from: number, label: string): Promise<void> {
    for (let offset = from; offset < out.length; ) {
      const reply = (await this.link.call({ type: ASYNC_MORE, part, offset })) as AsyncMoreReply;
      const bytes = reply?.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw syncError('EIO', label);
      if (offset + bytes.length > out.length) throw syncError('EIO', label);
      out.set(bytes, offset);
      offset += bytes.length;
    }
  }

  async snapshot(token: string, out: Uint8Array): Promise<void> {
    for (let offset = 0; offset < out.length; ) {
      const reply = (await this.link.call({
        type: ASYNC_SNAPSHOT,
        token,
        offset,
      })) as AsyncSnapshotReply;
      const bytes = reply?.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0)
        throw syncError('EIO', 'fork memory');
      if (offset + bytes.length > out.length) throw syncError('EIO', 'fork memory');
      out.set(bytes, offset);
      offset += bytes.length;
    }
  }

  async stage(body: Uint8Array): Promise<number> {
    const id = ++this.stages;
    for (let offset = 0; offset < body.length; offset += this.max) {
      const bytes = body.slice(offset, Math.min(body.length, offset + this.max));
      await this.link.call({ type: ASYNC_STAGE, stage: id, offset, total: body.length, bytes }, [
        bytes.buffer,
      ]);
    }
    return id;
  }

  staging(asked: SyncSabRequestBody): Uint8Array | undefined {
    const body = bodyOf(asked);
    return body && body.byteLength > this.max ? body : undefined;
  }

  async staged(
    asked: SyncSabRequestBody,
    body: Uint8Array,
    timeoutMs: number,
    label: string
  ): Promise<{ req: SyncSabRequestBody; transfer: Transferable[]; staged: number }> {
    const staged = await withTimeout(this.stage(body), timeoutMs, label).catch(() => {
      throw syncError('EIO', label);
    });
    const { body: _dropped, ...rest } = asked as SyncSabRequestBody & { body?: unknown };
    return { req: rest as SyncSabRequestBody, transfer: [], staged };
  }

  exact(
    asked: SyncSabRequestBody,
    given: Transferable[]
  ): { req: SyncSabRequestBody; transfer: Transferable[] } {
    const body = bodyOf(asked);
    if (!body) return { req: asked, transfer: given };
    const exact = exactCopy(body);
    if (exact.body === body) return { req: asked, transfer: given };
    return {
      req: { ...asked, body: exact.body } as SyncSabRequestBody,
      transfer: [...given, ...exact.transfer],
    };
  }

  async answer(reply: AsyncAnswer, timeoutMs: number, label: string, sink?: Uint8Array) {
    const { status, total, bytes } = reply;
    if (reply.part === undefined) {
      if (!sink || status !== SAB_STATUS_BYTES || bytes.length > sink.length) {
        return decodeSabResult(status, bytes);
      }
      const out = landing(status, bytes.length, sink);
      out.set(bytes);
      return decodeSabResult(status, out);
    }
    const out = landing(status, total, sink);
    out.set(bytes);
    await withTimeout(this.pull(reply.part, out, bytes.length, label), timeoutMs, label).catch(
      (err) => {
        throw (err as { code?: unknown }).code === 'EIO' ? err : syncError('EIO', label);
      }
    );
    return decodeSabResult(status, out);
  }
}

export function createAsyncTransport(
  link: KernelLink,
  options: AsyncTransportOptions = {}
): AsyncTransport {
  const mirrors = new Mirrors();
  const caller = new Caller(link, options.maxMessageBytes ?? Number.POSITIVE_INFINITY);
  const started = Promise.withResolvers<AsyncProcessInit>();
  let words = 0;
  let initialised = false;
  let closedBy: string | undefined;
  const current = () => mirrors.words(++words, options.memory?.());

  const begin = async (init: AsyncProcessInit): Promise<void> => {
    mirrors.start(init.mirror);
    if (options.maxMessageBytes === undefined && init.maxMessageBytes !== undefined) {
      caller.max = init.maxMessageBytes;
    }
    const fork = init.fork;
    const ref = fork?.snapshot;
    if (fork && ref) {
      delete fork.snapshot;
      const local = options.snapshots?.take(ref.token);
      if (local && local.byteLength === ref.total) {
        fork.memory = local;
        link.post({ type: ASYNC_SNAPSHOT_TAKEN, token: ref.token });
      } else {
        const whole = new Uint8Array(ref.total);
        await caller.snapshot(ref.token, whole);
        fork.memory = whole;
      }
    }
    const memory = init.fork?.memory as StagedBytes | Uint8Array | undefined;
    if (memory && !(memory instanceof Uint8Array) && init.fork) {
      const whole = new Uint8Array(memory.total);
      await caller.pull(memory.part, whole, 0, 'fork memory');
      init.fork.memory = whole;
    }
    started.resolve(init);
  };

  link.onMessage((message) => {
    const data = message as { type?: unknown; mirror?: MirrorUpdate } | undefined;
    if (!initialised && data?.type === 'wasm-process-init') {
      initialised = true;
      begin(data as unknown as AsyncProcessInit).catch((err) => started.reject(err));
    } else if (initialised && data?.type === ASYNC_MIRROR && data.mirror) {
      void mirrors.accept(data.mirror);
    }
  });
  link.onClose((reason) => {
    closedBy = reason;
    if (!initialised) started.reject(new Error(`the kernel link closed: ${reason}`));
    mirrors.failAll(syncError('EIO', `kernel link closed: ${reason}`));
  });

  const send = (
    msg: AsyncSyscallMsg,
    transfer: Transferable[],
    ms: number,
    label: string
  ): Promise<AsyncAnswer> => {
    const answered = link.call(msg, transfer).then(async (value) => {
      const reply = value as AsyncSyscallReply;
      if (!reply || !isAnswer(reply)) throw syncError('EIO', label);
      await mirrors.accept(reply.mirror);
      return reply;
    });
    answered.catch(() => undefined);
    return withTimeout(answered, ms, label).catch((err) => {
      throw (err as { code?: unknown }).code === 'EIO' ? err : syncError('EIO', label);
    });
  };

  const issue = async (
    asked: SyncSabRequestBody,
    given: Transferable[],
    ms: number,
    label: string
  ): Promise<AsyncAnswer> => {
    const words = current();
    const body = caller.staging(asked);
    if (!body) {
      const { req, transfer } = caller.exact(asked, given);
      return send({ type: ASYNC_SYSCALL, req, words }, transfer, ms, label);
    }
    const { req, staged } = await caller.staged(asked, body, ms, label);
    return send({ type: ASYNC_SYSCALL, req, words, staged }, [], ms, label);
  };

  return {
    init: started.promise,
    buffer: mirrors.buffer,
    header: mirrors.header,
    clock: mirrors.clock,
    get changes() {
      return mirrors.changes;
    },
    get cwds() {
      return mirrors.cwds;
    },
    get closed() {
      return closedBy !== undefined;
    },
    async call(asked, timeoutMs, label, given = [], sink) {
      if (closedBy !== undefined) throw syncError('EIO', label);
      const { req, token } = snapshotted(asked, options.snapshots);
      const forget = () => {
        if (token !== undefined) options.snapshots?.release(token);
      };
      try {
        const reply = await issue(req, given, timeoutMs, label);
        const result = await caller.answer(reply, timeoutMs, label, sink);
        if (!result.ok) forget();
        return result;
      } catch (err) {
        forget();
        throw err;
      }
    },
    wait(view, index, value, timeoutMs = Number.POSITIVE_INFINITY) {
      if (Atomics.load(view, index) !== value) return Promise.resolve('not-equal');
      if (closedBy !== undefined) {
        return Promise.reject(syncError('EIO', `kernel link closed: ${closedBy}`));
      }
      return mirrors.wait(view, index, value, timeoutMs);
    },
    notify: (view, index) => mirrors.notify(view, index),
    publish() {
      if (closedBy === undefined && initialised) {
        link.post({ type: ASYNC_WORDS, words: current() });
      }
    },
    post(message, transfer) {
      if (closedBy === undefined) link.post(message, transfer);
    },
    onClose: (handler) => link.onClose(handler),
  };
}
