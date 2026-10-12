import type { UsersMode } from '../fs/types.ts';
import { KernelError, OpenFile, type PollState } from './fd-table.ts';

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
  tag?: string;
  users: UsersMode;
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
    return req;
  } finally {
    bytes.fill(0);
  }
}

function errorReply(code: string, message: string): object {
  return { v: 1, error: { code, message } };
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

  constructor(broker: SealedBroker) {
    this.broker = broker;
  }

  send(bytes: Uint8Array, caller: SealedCaller, gone: AbortSignal): number {
    const length = bytes.length;
    const fields = parseSealed(bytes);
    this.reply = undefined;
    this.offset = 0;
    this.inflight?.control.abort('replaced');
    const control = new AbortController();
    const withdraw = () => control.abort('withdrawn');
    if (gone.aborted) withdraw();
    else gone.addEventListener('abort', withdraw, { once: true });
    const timer = setTimeout(() => control.abort('timeout'), this.broker.timeoutMs);
    const req = { ...fields, v: 1, op: fields.op as string, caller } as SealedRequest;
    const flight: Inflight = { control, done: Promise.resolve() };
    flight.done = this.answer(req, control.signal).then((reply) => {
      clearTimeout(timer);
      gone.removeEventListener('abort', withdraw);
      if (this.inflight !== flight) return;
      this.inflight = undefined;
      if (reply) this.reply = encoder.encode(JSON.stringify(reply));
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
        (reply) =>
          typeof reply === 'object' && reply !== null && !Array.isArray(reply)
            ? { v: 1, ...reply }
            : errorReply('EIO', 'the vault gave no reply'),
        (err: unknown) => errorReply('EIO', lineOf(err))
      );
    const reply = await Promise.race([asked, stopped]);
    if (!signal.aborted) return reply;
    return signal.reason === 'timeout'
      ? errorReply('ETIMEDOUT', 'the vault did not answer within 10 s')
      : undefined;
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      if (this.reply) {
        const out = this.reply.slice(this.offset, this.offset + max);
        this.offset += out.length;
        if (this.offset >= this.reply.length) {
          this.reply = undefined;
          this.offset = 0;
        }
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
    this.reply = undefined;
  }
}

export class SealedBroker {
  readonly hook: SealedHook | undefined;
  readonly users: UsersMode;
  readonly timeoutMs: number;

  constructor(hook: SealedHook | undefined, users: UsersMode, timeoutMs = SEALED_TIMEOUT_MS) {
    this.hook = hook;
    this.users = users;
    this.timeoutMs = timeoutMs;
  }

  open(): OpenFile {
    const channel = new SealedChannel(this);
    return new OpenFile({
      read: (max, signal) => channel.read(max, signal),
      write: async () => {
        throw new KernelError('EINVAL');
      },
      poll: () => channel.poll(),
      changed: (signal) => channel.changed(signal),
      close: () => channel.close(),
      sealed: channel,
    });
  }
}

export type { SealedChannel };
