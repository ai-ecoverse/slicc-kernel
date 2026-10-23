import type { UsersMode } from '../fs/types.ts';
import { KernelError, type OpenAccess, OpenFile, type PollState } from './fd-table.ts';

export const EMBEDDER_PATH = '/dev/embedder';
export const EMBEDDER_MINOR = 252;
export const EMBEDDER_HEADER_MAX = 64 * 1024;
export const EMBEDDER_WINDOW = 1024 * 1024;
export const EMBEDDER_BUDGET = 256 * 1024 * 1024;
export const EMBEDDER_PER_PROCESS = 16;
export const EMBEDDER_PROGRESS_PER_SECOND = 4;

const KIND = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const NL = 10;

export interface EmbedderStamp {
  pid: number;
  uid: number;
  gid: number;
  groups: number[];
  users: UsersMode;
  kind: string;
  tag?: string;
  tags?: string[];
}

export interface EmbedderKindPolicy {
  group?: string;
  users?: Array<string | number>;
}

export type EmbedderReply = ReadableStream<Uint8Array> | Uint8Array | string | undefined | void;

export interface EmbedderRequest {
  kind: string;
  options: Record<string, unknown>;
  body: ReadableStream<Uint8Array>;
  stamp: EmbedderStamp;
  signal: AbortSignal;
  progress(line: string): void;
}

export interface EmbedderHook {
  kinds: Readonly<Record<string, EmbedderKindPolicy>>;
  handle(request: EmbedderRequest): Promise<EmbedderReply>;
}

export interface EmbedderCaller {
  pid: number;
  shownPid: number;
  euid: number;
  egid: number;
  groups: number[];
  sessionUid: number;
  client: number;
  tags: readonly string[] | undefined;
  name: string;
  progress(line: string): void;
  closing(): AbortSignal;
}

export interface EmbedderLookup {
  groupId(name: string): Promise<number | undefined>;
  userId(name: string): Promise<number | undefined>;
}

const READY: PollState = { readable: true, writable: true, hangup: false };

function lineOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

const ERRNOS: Readonly<Record<string, 'EACCES' | 'ENOTSUP' | 'ENOENT'>> = {
  NotAllowedError: 'EACCES',
  AbortError: 'EACCES',
  NotSupportedError: 'ENOTSUP',
  NotFoundError: 'ENOENT',
};

export function embedderFailure(err: unknown): KernelError {
  if (err instanceof KernelError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  return new KernelError(ERRNOS[String(name)] ?? 'EIO', lineOf(err));
}

function headerOf(bytes: Uint8Array): { kind: string; options: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new KernelError('EINVAL', 'the request header is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new KernelError('EINVAL', 'the request header is not an object');
  const { kind, ...options } = parsed as Record<string, unknown>;
  if (typeof kind !== 'string' || kind.length > 64 || !KIND.test(kind))
    throw new KernelError('EINVAL', 'the request has no valid kind');
  return { kind, options };
}

function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function aborted(signal: AbortSignal | undefined): Promise<never> | undefined {
  if (!signal) return undefined;
  return new Promise<never>((_, reject) => {
    const stop = () => reject(new KernelError('EINTR'));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

async function interruptible<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const stop = aborted(signal);
  if (!stop) return work;
  stop.catch(() => undefined);
  return Promise.race([work, stop]);
}

class Budget {
  private used = 0;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  take(n: number): boolean {
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }
  give(n: number): void {
    this.used = Math.max(0, this.used - n);
  }
}

class BodyPipe {
  private queue: Uint8Array[] = [];
  private size = 0;
  private ended = false;
  private dropped = false;
  private wake: (() => void) | undefined;
  private room: (() => void) | undefined;
  readonly stream: ReadableStream<Uint8Array>;
  constructor() {
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (this.queue.length === 0 && !this.ended) {
            await new Promise<void>((resolve) => {
              this.wake = resolve;
            });
          }
          const next = this.queue.shift();
          if (next) {
            this.size -= next.length;
            this.room?.();
            controller.enqueue(next);
          } else controller.close();
        },
        cancel: () => this.drop(),
      },
      { highWaterMark: 0 }
    );
  }
  get full(): boolean {
    return this.size >= EMBEDDER_WINDOW;
  }
  drop(): void {
    this.dropped = true;
    this.queue = [];
    this.size = 0;
    this.end();
  }
  push(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.dropped) return;
    this.queue.push(bytes.slice());
    this.size += bytes.length;
    this.wake?.();
  }
  waitRoom(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.room = resolve;
    });
  }
  end(): void {
    this.ended = true;
    this.wake?.();
    this.room?.();
  }
}

function replyStream(reply: EmbedderReply): ReadableStream<Uint8Array> {
  if (reply instanceof ReadableStream) return reply;
  const bytes =
    typeof reply === 'string'
      ? new TextEncoder().encode(reply)
      : reply instanceof Uint8Array
        ? reply
        : new Uint8Array(0);
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

class Throttle {
  private window = 0;
  private count = 0;
  allow(now: number): boolean {
    if (now - this.window >= 1000) {
      this.window = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= EMBEDDER_PROGRESS_PER_SECOND;
  }
}

export class EmbedderChannel {
  readonly access: OpenAccess;
  readonly owner: number;
  caller: EmbedderCaller;
  private readonly broker: EmbedderBroker;
  private header: Uint8Array = new Uint8Array(0);
  private body: BodyPipe | undefined;
  private reply: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private replied: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
  private rest: Uint8Array | undefined;
  private done = false;
  private failure: KernelError | undefined;
  private reported = false;
  private readonly abort = new AbortController();
  private closed = false;
  private readonly throttle = new Throttle();

  constructor(broker: EmbedderBroker, access: OpenAccess, caller: EmbedderCaller) {
    this.broker = broker;
    this.access = access;
    this.caller = caller;
    this.owner = caller.pid;
  }

  get dispatched(): boolean {
    return this.body !== undefined;
  }

  private fail(err: unknown): KernelError {
    this.failure ??= embedderFailure(err);
    return this.failure;
  }

  private report(err: unknown): KernelError {
    this.reported = true;
    return this.fail(err);
  }

  private async dispatch(bytes: Uint8Array): Promise<void> {
    const { kind, options } = headerOf(bytes);
    const stamp = await this.broker.admit(kind, this.caller);
    const hook = this.broker.hookFor(this.caller.client) as EmbedderHook;
    const body = new BodyPipe();
    this.body = body;
    const prefix = this.caller.name;
    const progress = (line: string) => {
      if (this.throttle.allow(Date.now())) this.caller.progress(`${prefix}: ${lineOf(line)}`);
    };
    const asked = Promise.resolve()
      .then(() =>
        hook.handle({
          kind,
          options,
          body: body.stream,
          stamp,
          signal: this.abort.signal,
          progress,
        })
      )
      .then((reply) => {
        body.drop();
        return replyStream(reply).getReader();
      });
    this.replied = asked.catch((err: unknown) => {
      body.end();
      throw this.fail(err);
    });
    this.replied.catch(() => undefined);
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (this.access === 'read') throw new KernelError('EBADF');
    if (this.failure) throw this.report(this.failure);
    if (this.reply || this.done) throw new KernelError('EBADF');
    if (this.body) return this.writeBody(bytes, signal);
    const at = bytes.indexOf(NL);
    const head = at < 0 ? bytes : bytes.subarray(0, at);
    if (this.header.length + head.length > EMBEDDER_HEADER_MAX)
      throw this.report(new KernelError('EINVAL', 'the request header is too long'));
    this.header = joined(this.header, head);
    if (at < 0) return bytes.length;
    try {
      await this.dispatch(this.header);
    } catch (err) {
      throw this.report(err);
    }
    (this.body as BodyPipe | undefined)?.push(bytes.subarray(at + 1));
    return bytes.length;
  }

  private async writeBody(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    const body = this.body as BodyPipe;
    while (body.full && !this.failure) {
      await interruptible(body.waitRoom(), signal).catch((err: unknown) => {
        this.cancel('interrupted');
        throw err;
      });
    }
    if (this.failure) throw this.report(this.failure);
    body.push(bytes);
    return bytes.length;
  }

  private async readerOf(signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    if (this.reply) return this.reply;
    if (!this.body) {
      try {
        await this.dispatch(this.header);
      } catch (err) {
        throw this.fail(err);
      }
    }
    this.body?.end();
    this.reply = await interruptible(
      this.replied as Promise<ReadableStreamDefaultReader<Uint8Array>>,
      signal
    );
    return this.reply;
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.access === 'write') throw new KernelError('EBADF');
    if (this.failure) throw this.report(this.failure);
    if (this.done || max <= 0) return new Uint8Array(0);
    try {
      return await this.next(max, signal);
    } catch (err) {
      if (err instanceof KernelError && err.code === 'EINTR') {
        this.cancel('interrupted');
        throw err;
      }
      throw this.report(err);
    }
  }

  private async next(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    const reader = await this.readerOf(signal);
    let chunk = this.rest;
    this.rest = undefined;
    if (!chunk) {
      const got = await interruptible(reader.read(), signal);
      if (got.done) {
        this.done = true;
        return new Uint8Array(0);
      }
      chunk = got.value;
    }
    if (chunk.length > max) this.rest = chunk.subarray(max);
    return chunk.subarray(0, max);
  }

  poll(): PollState {
    return this.body?.full ? { ...READY, writable: false } : READY;
  }

  cancel(reason: 'interrupted' | 'closed'): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort(new DOMException(reason, 'AbortError'));
    this.body?.end();
    void this.reply?.cancel(reason).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const signal = this.caller.closing();
    this.closed = true;
    try {
      if (this.access === 'read') return;
      if (this.failure) {
        if (this.reported) return;
        throw this.report(this.failure);
      }
      if (this.access === 'both' && this.dispatched) return;
      if (!this.dispatched && this.header.length === 0) return;
      await this.drain(signal);
    } finally {
      if (!this.done) this.cancel('closed');
      this.broker.release(this);
    }
  }

  private async drain(signal?: AbortSignal): Promise<void> {
    try {
      const reader = await this.readerOf(signal);
      for (;;) {
        const got = await interruptible(reader.read(), signal);
        if (got.done) break;
      }
      this.done = true;
    } catch (err) {
      if (err instanceof KernelError && err.code === 'EINTR') this.cancel('interrupted');
      throw this.fail(err);
    }
  }
}

export class EmbedderBroker {
  readonly users: UsersMode;
  private readonly lookup: EmbedderLookup;
  private readonly hooks = new Map<number, EmbedderHook>();
  private readonly budget: Budget;
  private readonly open = new Map<number, Set<EmbedderChannel>>();

  readonly tagsOf: (pid: number) => readonly string[] | undefined;

  constructor(
    users: UsersMode,
    lookup: EmbedderLookup,
    tagsOf: (pid: number) => readonly string[] | undefined = () => undefined,
    budget = EMBEDDER_BUDGET
  ) {
    this.users = users;
    this.tagsOf = tagsOf;
    this.lookup = lookup;
    this.budget = new Budget(budget);
  }

  register(client: number, hook: EmbedderHook | undefined): () => void {
    if (!hook) return () => undefined;
    this.hooks.set(client, hook);
    return () => {
      if (this.hooks.get(client) === hook) this.hooks.delete(client);
    };
  }

  hookFor(client: number): EmbedderHook | undefined {
    return this.hooks.get(client);
  }

  private async allowed(policy: EmbedderKindPolicy, caller: EmbedderCaller): Promise<boolean> {
    if (caller.euid === 0 || caller.euid === caller.sessionUid) return true;
    if (policy.group !== undefined) {
      const gid = await this.lookup.groupId(policy.group);
      if (gid !== undefined && (caller.egid === gid || caller.groups.includes(gid))) return true;
    }
    for (const user of policy.users ?? []) {
      const uid = typeof user === 'number' ? user : await this.lookup.userId(user);
      if (uid === caller.euid) return true;
    }
    return false;
  }

  async admit(kind: string, caller: EmbedderCaller): Promise<EmbedderStamp> {
    const hook = this.hooks.get(caller.client);
    if (!hook) throw new KernelError('ENOTSUP', 'no page answers requests for this session');
    const policy = Object.hasOwn(hook.kinds, kind) ? hook.kinds[kind] : undefined;
    if (!policy) throw new KernelError('ENOTSUP', `this embedder does not answer ${kind}`);
    if (this.users !== 'off' && !(await this.allowed(policy, caller)))
      throw new KernelError('EACCES', `${kind} is not allowed for this user`);
    const tags = caller.tags;
    return {
      pid: caller.shownPid,
      uid: caller.euid,
      gid: caller.egid,
      groups: [...caller.groups],
      users: this.users,
      kind,
      ...(tags?.length ? { tag: tags[0] as string, tags: [...tags] } : {}),
    };
  }

  channel(access: OpenAccess, caller: EmbedderCaller): OpenFile {
    const mine = this.open.get(caller.pid) ?? new Set<EmbedderChannel>();
    if (mine.size >= EMBEDDER_PER_PROCESS)
      throw new KernelError('EMFILE', `at most ${EMBEDDER_PER_PROCESS} requests per process`);
    if (!this.budget.take(2 * EMBEDDER_WINDOW))
      throw new KernelError('EAGAIN', 'the embedder request budget is spent');
    const channel = new EmbedderChannel(this, access, caller);
    mine.add(channel);
    this.open.set(caller.pid, mine);
    return new OpenFile({
      read: channel.read.bind(channel),
      write: (bytes, signal) => channel.write(bytes, signal),
      poll: () => channel.poll(),
      close: () => channel.close(),
      embedder: channel,
    });
  }

  release(channel: EmbedderChannel): void {
    const mine = this.open.get(channel.owner);
    if (!mine?.delete(channel)) return;
    if (mine.size === 0) this.open.delete(channel.owner);
    this.budget.give(2 * EMBEDDER_WINDOW);
  }
}

export function kindsOf(hook: EmbedderHook): Record<string, EmbedderKindPolicy> {
  if (typeof hook?.handle !== 'function' || typeof hook.kinds !== 'object' || !hook.kinds)
    throw new TypeError('requests needs kinds and handle');
  return Object.fromEntries(
    Object.entries(hook.kinds).map(([kind, policy]) => [
      kind,
      {
        ...(policy?.group !== undefined ? { group: String(policy.group) } : {}),
        ...(policy?.users ? { users: [...policy.users] } : {}),
      },
    ])
  );
}
