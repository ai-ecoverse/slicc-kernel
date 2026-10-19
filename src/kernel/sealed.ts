import type { UsersMode } from '../fs/types.ts';
import type { Cred } from './cred.ts';
import { isStrings, stringRecord, TicketBook } from './exec-ticket.ts';
import { KernelError, type OpenAccess, OpenFile, type PollState } from './fd-table.ts';
import {
  type SessionFields,
  sessionAskable,
  sessionRequest,
  sessionValues,
} from './sealed-session.ts';

export const SEALED_PATH = '/dev/sealed';
export const SEALED_MAX_BYTES = 64 * 1024;
export const SEALED_TIMEOUT_MS = 10_000;
export const SEALED_OPS: ReadonlySet<string> = new Set([
  'seal',
  'placeholder',
  'list',
  'test',
  'request',
  'status',
  'cancel',
  'materialize',
]);

export interface SealedCaller {
  pid: number;
  ppid: number;
  uid: number;
  gid: number;
  user?: string;
  groups: number[];
  users: UsersMode;
  tag?: string;
}

export type SealedRequest = { v: 1; op: string; caller: SealedCaller } & Record<string, unknown>;

export type SealedHook = (req: SealedRequest, options: { signal: AbortSignal }) => Promise<object>;

export type SealedAbortReason = 'replaced' | 'timeout' | 'withdrawn';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function parseSealed(bytes: Uint8Array): Record<string, unknown> {
  try {
    if (bytes.length > SEALED_MAX_BYTES) throw new KernelError('EMSGSIZE');
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(bytes));
    } catch {
      throw new KernelError('EINVAL');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new KernelError('EINVAL');
    const req = parsed as Record<string, unknown>;
    if (req.v !== 1 || typeof req.op !== 'string' || !SEALED_OPS.has(req.op))
      throw new KernelError('EINVAL');
    if (req.op === 'materialize' && !materializable(req)) throw new KernelError('EINVAL');
    return req;
  } finally {
    bytes.fill(0);
  }
}

function materializable(req: Record<string, unknown>): boolean {
  if (req.shellGrants !== true && !isStrings(req.names)) return false;
  return isStrings(req.argv) && typeof req.path === 'string' && typeof req.cwd === 'string';
}

function errorReply(code: string, message: string): object {
  return { v: 1, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serialized(reply: object): string {
  let plain: unknown;
  try {
    const text = JSON.stringify(reply);
    plain = text === undefined ? undefined : JSON.parse(text);
  } catch (err) {
    return JSON.stringify(errorReply('EIO', lineOf(err)));
  }
  if (!isRecord(plain)) return JSON.stringify(errorReply('EIO', 'the vault gave no reply'));
  const { v: _, ...rest } = plain;
  return JSON.stringify({ v: 1, ...rest });
}

function lineOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

interface Inflight {
  control: AbortController;
  done: Promise<void>;
}

class SealedChannel {
  private reply: Uint8Array | undefined;
  private offset = 0;
  private inflight: Inflight | undefined;
  private readonly broker: SealedBroker;
  readonly access: OpenAccess;

  constructor(broker: SealedBroker, access: OpenAccess) {
    this.broker = broker;
    this.access = access;
  }

  send(bytes: Uint8Array, caller: SealedCaller, gone: AbortSignal): number {
    if (this.access === 'read') {
      bytes.fill(0);
      throw new KernelError('EBADF');
    }
    const length = bytes.length;
    const fields = parseSealed(bytes);
    this.drop();
    this.inflight?.control.abort('replaced');
    const control = new AbortController();
    const withdraw = () => control.abort('withdrawn');
    if (gone.aborted) withdraw();
    else gone.addEventListener('abort', withdraw, { once: true });
    const timer = setTimeout(() => control.abort('timeout'), this.broker.timeoutMs);
    const req = { ...fields, v: 1, op: fields.op as string, caller } as SealedRequest;
    const flight: Inflight = { control, done: Promise.resolve() };
    flight.done = this.answer(req, control.signal).then(async (reply) => {
      clearTimeout(timer);
      gone.removeEventListener('abort', withdraw);
      if (reply && req.op === 'materialize')
        await this.broker.tickets.record(req, reply, caller.pid);
      if (this.inflight !== flight) return;
      this.inflight = undefined;
      if (reply) this.reply = encoder.encode(serialized(reply));
    });
    this.inflight = flight;
    return length;
  }

  private async answer(req: SealedRequest, signal: AbortSignal): Promise<object | undefined> {
    const hook = this.broker.hook;
    if (!hook) return errorReply('ENOTCONN', 'no vault is connected');
    const stopped = new Promise<undefined>((resolve) => {
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    if (signal.aborted) return undefined;
    const asked = Promise.resolve()
      .then(() => hook(req, { signal }))
      .then(
        (reply) => (isRecord(reply) ? reply : errorReply('EIO', 'the vault gave no reply')),
        (err: unknown) => errorReply('EIO', lineOf(err))
      );
    const reply = await Promise.race([asked, stopped]);
    if (!signal.aborted) return reply;
    return signal.reason === 'timeout'
      ? errorReply('ETIMEDOUT', 'the vault did not answer within 10 s')
      : undefined;
  }

  private drop(): void {
    this.reply?.fill(0);
    this.reply = undefined;
    this.offset = 0;
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.access === 'write') throw new KernelError('EBADF');
    for (;;) {
      if (this.reply) {
        const out = this.reply.slice(this.offset, this.offset + max);
        this.offset += out.length;
        if (this.offset >= this.reply.length) this.drop();
        return out;
      }
      const flight = this.inflight;
      if (!flight) return new Uint8Array(0);
      await this.until(flight, signal);
    }
  }

  private async until(flight: Inflight, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return flight.done;
    if (signal.aborted) throw new KernelError('EINTR');
    let stop = (): void => {};
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => reject(new KernelError('EINTR'));
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      await Promise.race([flight.done, interrupted]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  poll(): PollState {
    return { readable: this.reply !== undefined || !this.inflight, writable: true, hangup: false };
  }

  async changed(signal?: AbortSignal): Promise<void> {
    const flight = this.inflight;
    if (flight) await this.until(flight, signal);
  }

  close(): void {
    this.inflight?.control.abort('withdrawn');
    this.inflight = undefined;
    this.drop();
  }
}

export interface ConsumeFields {
  ticket: string;
  stamp: SealedCaller;
  path: string;
  resolved: string;
  argv: string[];
  cwd: string;
  interpreters: string[];
  trusted: boolean;
}

export interface Swap {
  values: Record<string, string>;
  placeholders: Record<string, string>;
}

function swapOf(reply: unknown): Swap | undefined {
  if (!isRecord(reply) || reply.error !== undefined) return undefined;
  const values = stringRecord(reply.values);
  const placeholders = stringRecord(reply.placeholders);
  return values && placeholders ? { values, placeholders } : undefined;
}

export class SealedBroker {
  readonly hook: SealedHook | undefined;
  readonly users: UsersMode;
  readonly timeoutMs: number;
  readonly tagOf: (pid: number) => string | undefined;
  readonly tickets = new TicketBook();
  userOf: (uid: number) => Promise<string | undefined> = async () => undefined;

  constructor(
    hook: SealedHook | undefined,
    users: UsersMode,
    timeoutMs = SEALED_TIMEOUT_MS,
    tagOf: (pid: number) => string | undefined = () => undefined
  ) {
    this.hook = hook;
    this.users = users;
    this.timeoutMs = timeoutMs;
    this.tagOf = tagOf;
  }

  async stamp(
    ids: { pid: number; ppid: number },
    cred: Readonly<Cred>,
    tag: string | undefined
  ): Promise<SealedCaller> {
    const user = await this.userOf(cred.euid).catch(() => undefined);
    return {
      pid: ids.pid,
      ppid: ids.ppid,
      uid: cred.euid,
      gid: cred.egid,
      ...(user !== undefined ? { user } : {}),
      groups: [...cred.groups],
      users: this.users,
      ...(tag !== undefined ? { tag } : {}),
    };
  }

  async consume(fields: ConsumeFields): Promise<Swap | undefined> {
    const req = { ...fields, v: 1, op: 'materializeConsume', caller: fields.stamp };
    return this.ask(req as SealedRequest, swapOf);
  }

  async sessionMaterialize(
    fields: SessionFields,
    now = Date.now()
  ): Promise<Record<string, string> | undefined> {
    if (!sessionAskable(fields, now)) return undefined;
    const req = sessionRequest(fields);
    return this.ask(req, (reply) => sessionValues(reply, req.placeholders));
  }

  private async ask<T>(req: SealedRequest, parse: (reply: unknown) => T | undefined) {
    const { hook } = this;
    if (!hook) return undefined;
    const control = new AbortController();
    const timer = setTimeout(() => control.abort('timeout'), this.timeoutMs);
    const stopped = new Promise<undefined>((resolve) => {
      control.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    try {
      const asked = Promise.resolve()
        .then(() => hook(req, { signal: control.signal }))
        .then(parse, () => undefined);
      return await Promise.race([asked, stopped]);
    } finally {
      clearTimeout(timer);
      control.abort('done');
    }
  }

  open(access: OpenAccess = 'both'): OpenFile {
    const channel = new SealedChannel(this, access);
    return new OpenFile({
      ...(access === 'write' ? {} : { read: (max, signal) => channel.read(max, signal) }),
      ...(access === 'read'
        ? {}
        : {
            write: async () => {
              throw new KernelError('EINVAL');
            },
          }),
      poll: () => channel.poll(),
      changed: (signal) => channel.changed(signal),
      close: () => channel.close(),
      sealed: channel,
    });
  }
}

export type { SealedChannel };
