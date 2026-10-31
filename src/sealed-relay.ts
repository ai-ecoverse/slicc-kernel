import { fresh } from './bytes.ts';
import {
  dropSealedReply,
  type SealedFetchHook,
  type SealedFetchRequest,
  sealedReplyValid,
} from './kernel/net/sealed-fetch.ts';
import type { HeaderList, RealmTransportResponse as Response } from './kernel/net/transport.ts';
import type { SealedHook, SealedRequest } from './kernel/sealed.ts';

export interface SealedPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface SealedAsk {
  id: number;
  req: SealedRequest;
}

export interface SealedReply {
  id: number;
  reply?: object;
  error?: string;
}

export interface SealedAbort {
  id: number;
  reason: unknown;
}

type WireRequest = Omit<SealedFetchRequest, 'bodyStream'> & { streamed?: true };

export interface SealedFetchAsk {
  req: WireRequest;
  port: MessagePort;
}

type AskerMessage =
  | { t: 'pull' }
  | { t: 'stop' }
  | {
      t: 'head';
      status: number;
      statusText: string;
      headers: HeaderList;
      url?: string;
    }
  | { t: 'chunk'; bytes: Uint8Array }
  | { t: 'end' }
  | { t: 'error'; message: string };

type AnswererMessage =
  | { t: 'read' }
  | { t: 'cancel'; reason: string }
  | { t: 'chunk'; bytes: Uint8Array }
  | { t: 'end' }
  | { t: 'error'; message: string };

function textOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendBytes(port: MessagePort, bytes: Uint8Array): void {
  const copy = fresh(bytes);
  port.postMessage({ t: 'chunk', bytes: copy }, [copy.buffer as ArrayBuffer]);
}

function askFetch(
  port: SealedPort,
  req: SealedFetchRequest,
  signal: AbortSignal
): Promise<Response> {
  signal.throwIfAborted();
  const { bodyStream, ...wire } = req;
  const { port1: near, port2: far } = new MessageChannel();
  const upload = bodyStream?.[Symbol.asyncIterator]();
  const head = Promise.withResolvers<Response>();
  let reading: PromiseWithResolvers<IteratorResult<Uint8Array>> | undefined;
  let ended = false;

  const end = (failure: Error) => {
    if (ended) return;
    ended = true;
    signal.removeEventListener('abort', abort);
    near.close();
    void upload?.return?.().catch(() => undefined);
    head.reject(failure);
    reading?.reject(failure);
    reading = undefined;
  };
  const abort = () => {
    near.postMessage({ t: 'cancel', reason: String(signal.reason) } satisfies AnswererMessage);
    end(new Error(String(signal.reason)));
  };
  const pull = async () => {
    try {
      const next = await (upload as AsyncIterator<Uint8Array>).next();
      if (ended) return;
      if (next.done) near.postMessage({ t: 'end' } satisfies AnswererMessage);
      else sendBytes(near, next.value);
    } catch (err) {
      if (!ended) near.postMessage({ t: 'error', message: textOf(err) });
    }
  };
  const respond = (message: Extract<AskerMessage, { t: 'head' }>) => {
    const { status, statusText, headers, url } = message;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (ended) return Promise.resolve({ value: undefined, done: true });
          reading = Promise.withResolvers();
          near.postMessage({ t: 'read' } satisfies AnswererMessage);
          return reading.promise;
        },
        return: async () => {
          await cancel();
          return { value: undefined, done: true };
        },
      }),
    };
    const cancel = async () => {
      if (ended) return;
      near.postMessage({ t: 'cancel', reason: 'cancelled' } satisfies AnswererMessage);
      end(new Error('the request was cancelled'));
    };
    head.resolve({
      ...(url !== undefined ? { url } : {}),
      status,
      statusText,
      headers,
      body,
      cancel,
    });
  };
  near.addEventListener('message', ({ data }: MessageEvent<AskerMessage>) => {
    if (data.t === 'pull') void pull();
    else if (data.t === 'stop') void upload?.return?.().catch(() => undefined);
    else if (data.t === 'head') respond(data);
    else if (data.t === 'chunk') {
      reading?.resolve({ value: data.bytes, done: false });
      reading = undefined;
    } else if (data.t === 'end') {
      reading?.resolve({ value: undefined, done: true });
      reading = undefined;
      end(new Error('the response ended'));
    } else end(new Error(data.message));
  });
  near.addEventListener('close', () => end(new Error('the sealed fetch relay closed')));
  near.start();
  signal.addEventListener('abort', abort, { once: true });
  const ask: SealedFetchAsk = {
    req: { ...wire, ...(upload ? { streamed: true } : {}) },
    port: far,
  };
  port.postMessage({ sealedFetch: ask }, [far]);
  return head.promise;
}

interface FetchAnswer {
  close(reason: unknown): void;
}

function uploadOf(far: MessagePort): {
  stream: AsyncIterable<Uint8Array>;
  answer(message: Extract<AnswererMessage, { t: 'chunk' | 'end' | 'error' }>): void;
  fail(reason: Error): void;
} {
  let waiting: PromiseWithResolvers<IteratorResult<Uint8Array>> | undefined;
  let failure: Error | undefined;
  const next = () => {
    if (failure) return Promise.reject(failure);
    waiting = Promise.withResolvers();
    far.postMessage({ t: 'pull' } satisfies AskerMessage);
    return waiting.promise;
  };
  return {
    stream: {
      [Symbol.asyncIterator]: () => ({
        next,
        return: async () => {
          far.postMessage({ t: 'stop' } satisfies AskerMessage);
          return { value: undefined, done: true };
        },
      }),
    },
    answer(message) {
      if (message.t === 'chunk') waiting?.resolve({ value: message.bytes, done: false });
      else if (message.t === 'end') waiting?.resolve({ value: undefined, done: true });
      else {
        failure = new Error(message.message);
        waiting?.reject(failure);
      }
      waiting = undefined;
    },
    fail(reason) {
      failure = reason;
      waiting?.reject(reason);
      waiting = undefined;
    },
  };
}

function answerFetch(
  hook: SealedFetchHook | undefined,
  { req, port: far }: SealedFetchAsk,
  live: Set<FetchAnswer>
): void {
  const control = new AbortController();
  const { streamed, ...fields } = req;
  const upload = uploadOf(far);
  let source: AsyncIterator<Uint8Array> | undefined;
  let reply: Response | undefined;
  let closed = false;

  const settle = () => {
    closed = true;
    live.delete(answer);
    upload.fail(new Error('the request ended'));
  };
  const answer: FetchAnswer = {
    close(reason) {
      if (closed) return;
      settle();
      control.abort(reason);
      dropSealedReply(reply);
      far.close();
    },
  };
  const finish = (message: AskerMessage) => {
    if (closed) return;
    settle();
    far.postMessage(message);
  };
  const failWith = (err: unknown) => {
    dropSealedReply(reply);
    finish({ t: 'error', message: textOf(err) });
  };
  const read = async () => {
    try {
      const next = await (source as AsyncIterator<Uint8Array>).next();
      if (closed) return;
      if (next.done) finish({ t: 'end' });
      else if (next.value instanceof Uint8Array) sendBytes(far, next.value);
      else failWith('a body chunk is not bytes');
    } catch (err) {
      failWith(err);
    }
  };
  const ask = async () => {
    try {
      if (!hook) throw new Error('no vault is connected');
      const request: SealedFetchRequest = {
        ...fields,
        ...(streamed ? { bodyStream: upload.stream } : {}),
      };
      const answered: unknown = await hook(request, { signal: control.signal });
      if (!sealedReplyValid(answered)) {
        dropSealedReply(answered);
        throw new Error('the reply is not a scrubbed response');
      }
      if (closed) return dropSealedReply(answered);
      reply = answered;
      source = answered.body[Symbol.asyncIterator]();
      const { status, statusText, headers, url } = answered;
      far.postMessage({
        t: 'head',
        status,
        statusText,
        headers,
        ...(url !== undefined ? { url } : {}),
      } satisfies AskerMessage);
    } catch (err) {
      failWith(err);
    }
  };
  far.addEventListener('message', ({ data }: MessageEvent<AnswererMessage>) => {
    if (data.t === 'read') void read();
    else if (data.t === 'cancel') answer.close(data.reason);
    else upload.answer(data);
  });
  far.addEventListener('close', () => answer.close('withdrawn'));
  far.start();
  live.add(answer);
  void ask();
}

export function sealedAsker(port: SealedPort): {
  hook: SealedHook;
  fetch: SealedFetchHook;
  answer(reply: SealedReply): void;
} {
  const asks = new Map<number, PromiseWithResolvers<object>>();
  let next = 0;
  const hook: SealedHook = (req, { signal }) => {
    const id = ++next;
    const waiting = Promise.withResolvers<object>();
    asks.set(id, waiting);
    const abort = () => {
      if (!asks.delete(id)) return;
      port.postMessage({ sealedAbort: { id, reason: signal.reason } });
      waiting.reject(new Error(String(signal.reason)));
    };
    signal.addEventListener('abort', abort, { once: true });
    port.postMessage({ sealedAsk: { id, req } });
    return waiting.promise.finally(() => signal.removeEventListener('abort', abort));
  };
  const answer = ({ id, reply, error }: SealedReply) => {
    const waiting = asks.get(id);
    if (!waiting) return;
    asks.delete(id);
    if (reply) waiting.resolve(reply);
    else waiting.reject(new Error(error ?? 'no reply'));
  };
  return { hook, fetch: (req, { signal }) => askFetch(port, req, signal), answer };
}

export interface SealedAnswerer {
  handle(data: unknown): boolean;
  close(): void;
}

export function sealedAnswerer(
  port: SealedPort,
  hook: SealedHook | undefined,
  fetchHook?: SealedFetchHook
): SealedAnswerer {
  const asked = new Map<number, AbortController>();
  const fetches = new Set<FetchAnswer>();
  const ask = async ({ id, req }: SealedAsk): Promise<void> => {
    const control = new AbortController();
    asked.set(id, control);
    try {
      if (!hook) throw new Error('no vault is connected');
      const reply = await hook(req, { signal: control.signal });
      port.postMessage({ sealedReply: { id, reply } });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      port.postMessage({ sealedReply: { id, error } });
    } finally {
      asked.delete(id);
    }
  };
  const abort = ({ id, reason }: SealedAbort): void => {
    asked.get(id)?.abort(reason);
    asked.delete(id);
  };
  return {
    handle(data) {
      const message = data as {
        sealedAsk?: SealedAsk;
        sealedAbort?: SealedAbort;
        sealedFetch?: SealedFetchAsk;
      } | null;
      if (message?.sealedAsk) void ask(message.sealedAsk);
      else if (message?.sealedAbort) abort(message.sealedAbort);
      else if (message?.sealedFetch) answerFetch(fetchHook, message.sealedFetch, fetches);
      else return false;
      return true;
    },
    close() {
      for (const control of asked.values()) control.abort('withdrawn');
      asked.clear();
      for (const answer of [...fetches]) answer.close('withdrawn');
    },
  };
}
