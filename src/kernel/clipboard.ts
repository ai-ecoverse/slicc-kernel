import type { UsersMode } from '../fs/types.ts';
import { KernelError, type OpenAccess, OpenFile, type PollState } from './fd-table.ts';

export const CLIPBOARD_PATH = '/dev/clipboard';
export const CLIPBOARD_MINOR = 251;
export const CLIPBOARD_MAX_BYTES = 1024 * 1024;
export const CLIPBOARD_TIMEOUT_MS = 10_000;

export interface ClipboardStamp {
  pid: number;
  uid: number;
  gid: number;
  users: UsersMode;
  tag?: string;
}

export interface ClipboardHook {
  read(stamp: ClipboardStamp): Promise<string>;
  write(text: string, stamp: ClipboardStamp): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const READY: PollState = { readable: true, writable: true, hangup: false };

function lineOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

export function clipboardFailure(err: unknown): KernelError {
  if (err instanceof KernelError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  return new KernelError(name === 'NotAllowedError' ? 'EACCES' : 'EIO', lineOf(err));
}

function joined(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function interruptible<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new KernelError('EINTR');
  let stop = (): void => {};
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => reject(new KernelError('EINTR'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

class ClipboardChannel {
  stamp: ClipboardStamp;
  readonly access: OpenAccess;
  private readonly broker: ClipboardBroker;
  private snapshot: Promise<Uint8Array> | undefined;
  private taken: Uint8Array | undefined;
  private offset = 0;
  private chunks: Uint8Array[] = [];
  private size = 0;
  private wrote = false;
  private failed = false;
  private aborted = false;

  constructor(broker: ClipboardBroker, access: OpenAccess, stamp: ClipboardStamp) {
    this.broker = broker;
    this.access = access;
    this.stamp = stamp;
  }

  get unread(): boolean {
    return this.taken === undefined && this.snapshot === undefined;
  }

  get settled(): boolean {
    return this.taken !== undefined;
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.access === 'write') throw new KernelError('EBADF');
    if (!this.taken) {
      if (!this.snapshot) {
        const stamp = this.stamp;
        const asked = this.broker.ask(async (hook) => {
          const text = await hook.read(stamp);
          if (typeof text !== 'string') throw new KernelError('EIO', 'the clipboard gave no text');
          return encoder.encode(text);
        });
        this.snapshot = asked;
        asked.then(
          (bytes) => {
            if (this.snapshot === asked) this.taken = bytes;
          },
          () => {
            if (this.snapshot === asked) this.snapshot = undefined;
          }
        );
      }
      this.taken = await interruptible(this.snapshot, signal);
    }
    const out = this.taken.subarray(this.offset, this.offset + max);
    this.offset += out.length;
    return out;
  }

  write(bytes: Uint8Array): number {
    if (this.access === 'read') throw new KernelError('EBADF');
    this.wrote = true;
    if (this.failed) throw new KernelError('EFBIG');
    if (this.size + bytes.length > CLIPBOARD_MAX_BYTES) {
      this.failed = true;
      this.chunks = [];
      this.size = 0;
      throw new KernelError('EFBIG');
    }
    if (bytes.length > 0) this.chunks.push(bytes.slice());
    this.size += bytes.length;
    return bytes.length;
  }

  poll(): PollState {
    return READY;
  }

  abort(): void {
    this.aborted = true;
  }

  async close(): Promise<void> {
    this.snapshot = undefined;
    this.taken = undefined;
    const commits = this.access === 'write' || (this.access === 'both' && this.wrote);
    if (!commits || this.failed || this.aborted) return;
    const bytes = joined(this.chunks, this.size);
    this.chunks = [];
    this.size = 0;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new KernelError('EILSEQ', 'the text is not valid UTF-8');
    }
    const stamp = this.stamp;
    await this.broker.ask(async (hook) => {
      await hook.write(text, stamp);
    });
  }
}

export class ClipboardBroker {
  readonly hook: ClipboardHook | undefined;
  readonly users: UsersMode;
  readonly timeoutMs: number;
  readonly tagOf: (pid: number) => string | undefined;

  constructor(
    hook: ClipboardHook | undefined,
    users: UsersMode,
    timeoutMs = CLIPBOARD_TIMEOUT_MS,
    tagOf: (pid: number) => string | undefined = () => undefined
  ) {
    this.hook = hook;
    this.users = users;
    this.timeoutMs = timeoutMs;
    this.tagOf = tagOf;
  }

  async ask<T>(work: (hook: ClipboardHook) => Promise<T>): Promise<T> {
    const hook = this.hook;
    if (!hook) throw new KernelError('ENOTSUP', 'no clipboard in this embedder');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new KernelError('EIO', 'clipboard timed out')),
        this.timeoutMs
      );
    });
    const asked = Promise.resolve()
      .then(() => work(hook))
      .catch((err: unknown) => {
        throw clipboardFailure(err);
      });
    try {
      return await Promise.race([asked, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  open(access: OpenAccess, stamp: ClipboardStamp): OpenFile {
    const channel = new ClipboardChannel(this, access, stamp);
    return new OpenFile({
      read: (max, signal) => channel.read(max, signal),
      write: async (bytes) => channel.write(bytes),
      poll: () => channel.poll(),
      close: () => channel.close(),
      clipboard: channel,
    });
  }
}

export type { ClipboardChannel };
