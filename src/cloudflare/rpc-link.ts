import { pack, unpack } from './rpc-pack.ts';

export interface Answer {
  value: unknown;
  held?: number;
  count?: number;
}

export interface WireEnd {
  part(bytes: Uint8Array): unknown;
  post(value: unknown, count: number): unknown;
}

export interface KernelEndStub extends WireEnd {
  call(value: unknown, count: number, sent?: number): Promise<Answer>;
  take(held: number, index: number): Promise<Uint8Array>;
  dup(): KernelEndStub;
}

export interface ProcessEndStub extends WireEnd {
  close(reason: string): Promise<void>;
  settled(): Promise<string>;
}

const ignore = (): void => {};

const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose;

export function dispose(stub: object): void {
  const disposer = (stub as Record<symbol, (() => void) | undefined>)[DISPOSE];
  try {
    disposer?.call(stub);
  } catch {}
}

export function quietly(result: unknown): void {
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    (result as Promise<unknown>).then(ignore, ignore);
  }
}

export function send(end: WireEnd, message: unknown): void {
  const { value, pieces } = pack(message);
  for (const piece of pieces) quietly(end.part(piece));
  quietly(end.post(value, pieces.length));
}

export class Inbox {
  private readonly pieces: Uint8Array[] = [];
  private readonly early: unknown[] = [];
  private handlers: ((message: unknown) => void)[] = [];

  part(bytes: Uint8Array): void {
    this.pieces.push(bytes);
  }

  take(value: unknown, count: number): unknown {
    return unpack(value, this.pieces.splice(0, count));
  }

  deliver(message: unknown): void {
    if (this.handlers.length === 0) {
      this.early.push(message);
      return;
    }
    for (const handler of this.handlers) handler(message);
  }

  listen(handler: (message: unknown) => void): void {
    this.handlers.push(handler);
    if (this.handlers.length > 1) return;
    for (const message of this.early.splice(0)) handler(message);
  }

  clear(): void {
    this.pieces.length = 0;
    this.early.length = 0;
    this.handlers = [];
  }
}

export class Held {
  private next = 1;
  private readonly answers = new Map<number, Uint8Array[]>();

  answer(result: unknown): Answer {
    const { value, pieces } = pack(result);
    if (pieces.length === 0) return { value };
    const held = this.next++;
    this.answers.set(held, pieces);
    return { value, held, count: pieces.length };
  }

  take(held: number, index: number): Uint8Array {
    const pieces = this.answers.get(held);
    const piece = pieces?.[index];
    if (!pieces || !piece) throw new Error(`no piece ${index} of answer ${held}`);
    pieces[index] = new Uint8Array(0);
    if (index === pieces.length - 1) this.answers.delete(held);
    return piece;
  }

  clear(): void {
    this.answers.clear();
  }
}

export async function answered(end: KernelEndStub, answer: Answer): Promise<unknown> {
  const { value, held, count } = answer;
  if (held === undefined || !count) return value;
  const pieces: Uint8Array[] = [];
  for (let index = 0; index < count; index++) pieces.push(await end.take(held, index));
  return unpack(value, pieces);
}

export class Closers {
  private readonly handlers: ((reason: string) => void)[] = [];
  private readonly pending = new Set<(err: Error) => void>();
  reason: string | undefined;

  listen(handler: (reason: string) => void): void {
    const reason = this.reason;
    if (reason === undefined) this.handlers.push(handler);
    else queueMicrotask(() => handler(reason));
  }

  guard<T>(work: Promise<T>): Promise<T> {
    if (this.reason !== undefined) return Promise.reject(new Error(`link closed: ${this.reason}`));
    let reject: (err: Error) => void = () => {};
    const ended = new Promise<never>((_, fail) => {
      reject = fail;
    });
    this.pending.add(reject);
    return Promise.race([work, ended]).finally(() => this.pending.delete(reject));
  }

  close(reason: string): boolean {
    if (this.reason !== undefined) return false;
    this.reason = reason;
    const err = new Error(`link closed: ${reason}`);
    for (const reject of [...this.pending]) reject(err);
    this.pending.clear();
    for (const handler of this.handlers.splice(0)) handler(reason);
    return true;
  }
}
