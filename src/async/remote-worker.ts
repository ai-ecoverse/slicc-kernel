import type { WasmWorkerLike } from '../kernel/host.ts';
import {
  JS_THREAD_INIT,
  JS_THREAD_SPAWN,
  type ProcessInitMsg,
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  WASM_THREAD_INIT,
  WASM_THREAD_SPAWN,
  type WasmProcessInitMsg,
  type WasmProgram,
} from '../kernel/protocol.ts';
import {
  encodeSabResult,
  loadU53,
  SAB_CLOCK_I64,
  SAB_CLOCK_OFFSET,
  SAB_I_ASYNC,
  SAB_I_CHUNK,
  SAB_I_KILLED,
  SAB_I_MEMORY,
  SAB_I_OFFSET,
  SAB_I_OFFSET_HI,
  SAB_I_PUB,
  SAB_I_REQ,
  SAB_I_SEQ,
  SAB_I_SIGNALS,
  SAB_I_STATE,
  SAB_I_STATUS,
  SAB_I_STOP,
  SAB_I_TIMERS,
  SAB_I_TOTAL,
  SAB_I_TOTAL_HI,
  SAB_STATE_IDLE,
  SAB_STATE_PENDING,
  SAB_STATE_READY,
  SYNC_SAB_NEXT_MSG,
  SYNC_SAB_REQ_MSG,
  type SyncSabRequestBody,
  sabViews,
  storeBlocked,
} from '../realm/sync-sab-wire.ts';
import { watchHeader } from './header-hook.ts';
import type { ProcessLink } from './link.ts';
import {
  ASYNC_MIRROR,
  ASYNC_MORE,
  ASYNC_SNAPSHOT,
  ASYNC_STAGE,
  ASYNC_SYSCALL,
  ASYNC_WORDS,
  type AsyncAnswer,
  type AsyncMoreMsg,
  type AsyncMoreReply,
  type AsyncProcessInit,
  type AsyncSnapshotMsg,
  type AsyncSnapshotReply,
  type AsyncStageMsg,
  type AsyncSyscallMsg,
  type AsyncSyscallReply,
  diffRuns,
  type MirroredBuffer,
  type MirrorUpdate,
  type ProcessWords,
} from './wire.ts';

export interface RemoteWorkerOptions {
  maxMessageBytes?: number;
  snapshot?: (token: string, offset: number, max: number) => Promise<Uint8Array> | Uint8Array;
  image?: (program: WasmProgram) => string | undefined;
}

type Listener = (event: MessageEvent) => void;

const PART_TTL_MS = 60_000;
const SNAPSHOT_PART_BYTES = 16 * 2 ** 20;
const NOT_RUNNABLE = 126;
const CLOCK_BLOCKED = 0;
const CLOCK_IDLE = 1;

export const ASYNC_NO_JS = 'the async process host runs no JS programs';
export const ASYNC_NO_THREADS = 'the async process host runs no threads';

function defaultImage(program: WasmProgram): string | undefined {
  const image = (program.module as unknown as { image?: unknown } | undefined)?.image;
  return typeof image === 'string' ? image : undefined;
}

interface Mirror {
  view: Int32Array;
  last: Int32Array;
}

function mirrorOf(sab: SharedArrayBuffer | undefined): Mirror | undefined {
  if (!sab) return undefined;
  const view = new Int32Array(sab);
  return { view, last: new Int32Array(view.length) };
}

function initial(mirror: Mirror | undefined): MirroredBuffer | undefined {
  if (!mirror) return undefined;
  return {
    bytes: mirror.view.byteLength,
    runs: diffRuns(mirror.last, mirror.view) ?? new Int32Array(0),
  };
}

interface Pending {
  id: number;
  resolve: (reply: AsyncSyscallReply) => void;
  out: Uint8Array | null;
  status: number;
  offset: number;
}

interface Part {
  bytes: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
}

class KernelSide {
  private readonly header: Int32Array;
  private readonly window: Uint8Array;
  private readonly clock: BigInt64Array;
  private readonly changes: Mirror | undefined;
  private readonly cwds: Mirror | undefined;
  private readonly unwatch: () => void;
  private readonly history: Array<{ seq: number; signals: number; timers: number }> = [];
  private raised = { signals: 0, timers: 0 };
  private sent = { killed: 0, async: 0, stop: 0, clock: 0 };
  private seq = 0;
  private words = 0;
  private requests = 0;
  private parts = new Map<number, Part>();
  private stages = new Map<number, Uint8Array>();
  private nextPart = 0;
  private current: Pending | undefined;
  private pushing = false;
  private pumping = false;
  private ended = false;
  private readonly max: number;
  private readonly emit: (data: unknown) => void;
  private readonly push: (message: unknown) => void;

  constructor(
    init: WasmProcessInitMsg,
    max: number,
    emit: (data: unknown) => void,
    push: (message: unknown) => void
  ) {
    const { header, window } = sabViews(init.sab);
    this.header = header;
    this.window = window;
    this.clock = new BigInt64Array(init.sab, SAB_CLOCK_OFFSET, SAB_CLOCK_I64);
    this.changes = mirrorOf(init.changes);
    this.cwds = mirrorOf(init.held?.sab);
    this.max = max;
    this.emit = emit;
    this.push = push;
    this.unwatch = watchHeader(init.sab, (index, bits) => this.notified(index, bits));
    this.sent = this.words4();
  }

  wire(init: WasmProcessInitMsg, image: string): AsyncProcessInit {
    const { sab: _sab, changes: _changes, held, program, fork, ...rest } = init;
    const { module: _module, ...shown } = program;
    const memory = fork?.memory;
    let forkWire: AsyncProcessInit['fork'];
    if (fork && memory && memory.byteLength > this.max) {
      forkWire = { ...fork, memory: { part: this.keep(memory.slice()), total: memory.byteLength } };
    } else if (fork) forkWire = fork;
    const changes = initial(this.changes);
    const cwds = initial(this.cwds);
    return {
      ...rest,
      program: { ...shown, image },
      ...(held ? { held: { slot: held.slot, seen: held.seen, dead: held.dead } } : {}),
      ...(forkWire ? { fork: forkWire } : {}),
      ...(Number.isFinite(this.max) ? { maxMessageBytes: this.max } : {}),
      mirror: {
        seq: 0,
        header: Int32Array.from(this.header),
        clock: [
          Number(Atomics.load(this.clock, CLOCK_BLOCKED)),
          Number(Atomics.load(this.clock, CLOCK_IDLE)),
        ],
        ...(changes ? { changes } : {}),
        ...(cwds ? { cwds } : {}),
      },
    };
  }

  private words4(): { killed: number; async: number; stop: number; clock: number } {
    return {
      killed: Atomics.load(this.header, SAB_I_KILLED),
      async: Atomics.load(this.header, SAB_I_ASYNC),
      stop: Atomics.load(this.header, SAB_I_STOP),
      clock: Number(Atomics.load(this.clock, CLOCK_BLOCKED)),
    };
  }

  private notified(index: number, bits: number): void {
    if (this.ended) return;
    if (index === SAB_I_PUB) {
      this.schedulePump();
      return;
    }
    if (index === SAB_I_SIGNALS) this.raised.signals |= bits;
    else if (index === SAB_I_TIMERS) this.raised.timers |= bits;
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.pushing) return;
    this.pushing = true;
    queueMicrotask(() => {
      this.pushing = false;
      if (this.ended) return;
      const mirror = this.mirror(false);
      if (mirror) this.push({ type: ASYNC_MIRROR, mirror });
    });
  }

  private mirror(always: true): MirrorUpdate;
  private mirror(always: boolean): MirrorUpdate | undefined;
  private mirror(always: boolean): MirrorUpdate | undefined {
    const now = this.words4();
    const { signals, timers } = this.raised;
    const changes = this.changes ? diffRuns(this.changes.last, this.changes.view) : undefined;
    const cwds = this.cwds ? diffRuns(this.cwds.last, this.cwds.view) : undefined;
    const same =
      now.killed === this.sent.killed &&
      now.async === this.sent.async &&
      now.stop === this.sent.stop &&
      now.clock === this.sent.clock;
    if (!always && same && signals === 0 && timers === 0 && !changes && !cwds) return undefined;
    const seq = ++this.seq;
    this.raised = { signals: 0, timers: 0 };
    this.sent = now;
    if (signals !== 0 || timers !== 0) this.history.push({ seq, signals, timers });
    return {
      seq,
      signals,
      timers,
      ...now,
      ...(changes ? { changes } : {}),
      ...(cwds ? { cwds } : {}),
    };
  }

  applyWords(words: ProcessWords): void {
    if (!words || typeof words.n !== 'number' || words.n <= this.words) return;
    this.words = words.n;
    while (this.history.length > 0 && (this.history[0]?.seq ?? 0) <= words.seen) {
      this.history.shift();
    }
    let signals = words.signals | this.raised.signals;
    let timers = words.timers | this.raised.timers;
    for (const entry of this.history) {
      signals |= entry.signals;
      timers |= entry.timers;
    }
    Atomics.store(this.header, SAB_I_SIGNALS, signals);
    Atomics.store(this.header, SAB_I_TIMERS, timers);
    storeBlocked(this.header, words.blocked);
    Atomics.store(this.header, SAB_I_MEMORY, words.memory);
    Atomics.store(this.clock, CLOCK_IDLE, BigInt(words.idle));
  }

  private keep(bytes: Uint8Array): number {
    const id = ++this.nextPart;
    const timer = setTimeout(() => this.parts.delete(id), PART_TTL_MS);
    this.parts.set(id, { bytes, timer });
    return id;
  }

  more(msg: AsyncMoreMsg): AsyncMoreReply {
    const part = this.parts.get(msg.part);
    if (!part || !Number.isInteger(msg.offset) || msg.offset < 0) {
      throw new Error('async: unknown or expired answer part');
    }
    const end = Math.min(part.bytes.length, msg.offset + this.max);
    const bytes = part.bytes.slice(msg.offset, end);
    if (end >= part.bytes.length) {
      clearTimeout(part.timer);
      this.parts.delete(msg.part);
    } else {
      clearTimeout(part.timer);
      part.timer = setTimeout(() => this.parts.delete(msg.part), PART_TTL_MS);
    }
    return { bytes };
  }

  stage(msg: AsyncStageMsg): null {
    let into = this.stages.get(msg.stage);
    if (!into) {
      into = new Uint8Array(msg.total);
      this.stages.set(msg.stage, into);
    }
    into.set(msg.bytes, msg.offset);
    return null;
  }

  syscall(msg: AsyncSyscallMsg): Promise<AsyncSyscallReply> {
    if (this.ended) return Promise.resolve({ failed: 'terminated' });
    this.current?.resolve({ failed: 'superseded' });
    this.current = undefined;
    this.applyWords(msg.words);
    let req: SyncSabRequestBody = msg.req;
    if (msg.staged !== undefined) {
      const body = this.stages.get(msg.staged);
      this.stages.delete(msg.staged);
      if (!body) return Promise.resolve({ failed: 'unknown staged body' });
      req = { ...req, body } as SyncSabRequestBody;
    }
    const id = ++this.requests;
    const { promise, resolve } = Promise.withResolvers<AsyncSyscallReply>();
    this.current = { id, resolve, out: null, status: 0, offset: 0 };
    Atomics.store(this.header, SAB_I_REQ, id);
    Atomics.store(this.header, SAB_I_STATE, SAB_STATE_PENDING);
    this.emit({ type: SYNC_SAB_REQ_MSG, id, req });
    return promise;
  }

  private schedulePump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      this.pump();
    });
  }

  private pump(): void {
    const pending = this.current;
    if (this.ended || !pending) return;
    const { header } = this;
    if (Atomics.load(header, SAB_I_STATE) !== SAB_STATE_READY) return;
    if (Atomics.load(header, SAB_I_SEQ) !== pending.id) return;
    const total = loadU53(header, SAB_I_TOTAL, SAB_I_TOTAL_HI);
    const chunk = Atomics.load(header, SAB_I_CHUNK);
    const at = loadU53(header, SAB_I_OFFSET, SAB_I_OFFSET_HI);
    if (at !== pending.offset || chunk < 0 || total < 0 || at + chunk > total) {
      this.answer(pending, encodeSabResult({ ok: false, errno: 'EIO', message: 'async: torn' }));
      return;
    }
    if (pending.out === null) {
      pending.status = Atomics.load(header, SAB_I_STATUS);
      pending.out = new Uint8Array(total);
    }
    pending.out.set(this.window.subarray(0, chunk), at);
    pending.offset += chunk;
    if (pending.offset >= total) {
      this.answer(pending, { status: pending.status, payload: pending.out });
      return;
    }
    if (chunk === 0) {
      this.answer(pending, encodeSabResult({ ok: false, errno: 'EIO', message: 'async: stall' }));
      return;
    }
    Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
    this.emit({ type: SYNC_SAB_NEXT_MSG, id: pending.id, offset: pending.offset });
  }

  private answer(pending: Pending, { status, payload }: { status: number; payload: Uint8Array }) {
    if (this.current === pending) this.current = undefined;
    Atomics.store(this.header, SAB_I_REQ, 0);
    Atomics.store(this.header, SAB_I_STATE, SAB_STATE_IDLE);
    const mirror = this.mirror(true);
    const total = payload.byteLength;
    const reply: AsyncAnswer =
      total > this.max
        ? {
            status,
            bytes: payload.slice(0, this.max),
            total,
            part: this.keep(payload),
            mirror,
          }
        : { status, bytes: payload, total, mirror };
    pending.resolve(reply);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.unwatch();
    this.current?.resolve({ failed: 'terminated' });
    this.current = undefined;
    for (const part of this.parts.values()) clearTimeout(part.timer);
    this.parts.clear();
    this.stages.clear();
  }
}

function refusal(init: ProcessInitMsg | { type?: unknown }): string | undefined {
  const type = (init as { type?: unknown }).type;
  if (type === WASM_THREAD_INIT || type === JS_THREAD_INIT) return ASYNC_NO_THREADS;
  if (type !== WASM_PROCESS_INIT) return 'the async process host got no process init';
  if ((init as ProcessInitMsg).program?.abi === 'js') return ASYNC_NO_JS;
  return undefined;
}

export function remoteWorker(
  open: (init: AsyncProcessInit) => ProcessLink | Promise<ProcessLink>,
  options: RemoteWorkerOptions = {}
): WasmWorkerLike {
  const max = options.maxMessageBytes ?? Number.POSITIVE_INFINITY;
  const imageOf = options.image ?? defaultImage;
  const messages = new Set<Listener>();
  const errors = new Set<Listener>();
  let started = false;
  let ended = false;
  let exited = false;
  let link: ProcessLink | undefined;
  let side: KernelSide | undefined;

  const emit = (data: unknown): void => {
    if (ended) return;
    for (const handler of [...messages]) handler({ data } as MessageEvent);
  };
  const fail = (message: string): void => {
    if (ended || exited) return;
    for (const handler of [...errors]) {
      handler({ message, preventDefault() {} } as unknown as MessageEvent);
    }
  };
  const refuse = (message: string, code?: number): void => {
    queueMicrotask(() =>
      emit({ type: WASM_PROCESS_ERROR, message, ...(code === undefined ? {} : { code }) })
    );
  };

  const fromProcess = (message: unknown): void => {
    if (ended) return;
    const data = message as { type?: unknown; words?: ProcessWords } | undefined;
    const type = data?.type;
    if (type === ASYNC_WORDS) {
      if (data?.words) side?.applyWords(data.words);
      return;
    }
    if (type === WASM_THREAD_SPAWN || type === JS_THREAD_SPAWN) {
      emit({ type: WASM_PROCESS_ERROR, message: ASYNC_NO_THREADS });
      return;
    }
    if (type === WASM_PROCESS_EXIT) exited = true;
    emit(message);
  };

  const snapshotPart = async (msg: AsyncSnapshotMsg): Promise<AsyncSnapshotReply> => {
    if (!options.snapshot) throw new Error('async: this kernel keeps no fork snapshots');
    const limit = Number.isFinite(max) ? max : SNAPSHOT_PART_BYTES;
    return { bytes: await options.snapshot(msg.token, msg.offset, limit) };
  };

  const answer = async (message: unknown): Promise<unknown> => {
    const data = message as { type?: unknown } | undefined;
    if (!side) return { failed: 'terminated' };
    switch (data?.type) {
      case ASYNC_SYSCALL:
        return side.syscall(data as AsyncSyscallMsg);
      case ASYNC_MORE:
        return side.more(data as AsyncMoreMsg);
      case ASYNC_STAGE:
        return side.stage(data as AsyncStageMsg);
      case ASYNC_SNAPSHOT:
        return snapshotPart(data as AsyncSnapshotMsg);
      default:
        throw new Error(`async: unknown call ${String(data?.type)}`);
    }
  };

  const start = async (init: WasmProcessInitMsg): Promise<void> => {
    const image = imageOf(init.program);
    if (image === undefined) {
      refuse('the async process host needs a program image id', NOT_RUNNABLE);
      return;
    }
    const kernel = new KernelSide(init, max, emit, (msg) => link?.post(msg));
    side = kernel;
    const wire = kernel.wire(init, image);
    let opened: ProcessLink;
    try {
      opened = await open(wire);
    } catch (err) {
      kernel.end();
      queueMicrotask(() => fail(err instanceof Error ? err.message : String(err)));
      return;
    }
    if (ended) {
      opened.close();
      return;
    }
    link = opened;
    opened.onClose((reason) => {
      if (ended) return;
      kernel.end();
      fail(`the async process link closed: ${reason}`);
    });
    opened.onPost(fromProcess);
    opened.onCall(answer);
    opened.post(wire);
  };

  return {
    postMessage(message) {
      if (started || ended) return;
      started = true;
      const refused = refusal(message as ProcessInitMsg);
      if (refused) {
        refuse(refused, refused === ASYNC_NO_JS ? NOT_RUNNABLE : undefined);
        return;
      }
      void start(message as WasmProcessInitMsg);
    },
    addEventListener(type, handler) {
      (type === 'error' ? errors : messages).add(handler);
    },
    removeEventListener(type, handler) {
      (type === 'error' ? errors : messages).delete(handler);
    },
    terminate() {
      if (ended) return;
      ended = true;
      side?.end();
      link?.close();
    },
  };
}
