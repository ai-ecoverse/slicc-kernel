import { BODY_IDLE_MS } from '../../body-idle.ts';
import type { SealedCaller, SealedHook } from '../sealed.ts';
import { PlaceholderRefused } from './placeholder-floor.ts';
import type { HeaderList, RealmTransportRequest, RealmTransportResponse } from './transport.ts';

export const SEALED_FETCH_VERSION = 1;

const UNSAFE_FIELD = /[\r\n\0]/;

export interface SealedFetchRequest {
  v: 1;
  caller: SealedCaller;
  method: string;
  url: string;
  headers: HeaderList;
  redirect: 'manual';
  body?: Uint8Array;
  bodyStream?: AsyncIterable<Uint8Array>;
}

export type SealedFetchHook = (
  req: SealedFetchRequest,
  options: { signal: AbortSignal }
) => Promise<RealmTransportResponse>;

export type SealedOption = SealedHook | { request: SealedHook; fetch?: SealedFetchHook };

export function sealedHooks(option: SealedOption | undefined): {
  request?: SealedHook;
  fetch?: SealedFetchHook;
} {
  if (!option) return {};
  if (typeof option === 'function') return { request: option };
  const { request, fetch } = option;
  if (typeof request !== 'function' || (fetch !== undefined && typeof fetch !== 'function')) {
    throw new TypeError('sealed takes a function or { request, fetch? }');
  }
  return { request, ...(fetch ? { fetch } : {}) };
}

function headerList(headers: unknown): headers is HeaderList {
  return (
    Array.isArray(headers) &&
    headers.every(
      (field) =>
        Array.isArray(field) &&
        field.length === 2 &&
        field.every((text) => typeof text === 'string' && !UNSAFE_FIELD.test(text))
    )
  );
}

export function sealedReplyValid(reply: unknown): reply is RealmTransportResponse {
  if (typeof reply !== 'object' || reply === null) return false;
  const { redirects, redirected, status, statusText, headers, url, body, cancel } =
    reply as Partial<RealmTransportResponse>;
  return (
    redirects === undefined &&
    redirected !== true &&
    Number.isInteger(status) &&
    (status as number) >= 100 &&
    (status as number) <= 599 &&
    typeof statusText === 'string' &&
    !UNSAFE_FIELD.test(statusText) &&
    headerList(headers) &&
    (url === undefined || typeof url === 'string') &&
    typeof body?.[Symbol.asyncIterator] === 'function' &&
    typeof cancel === 'function'
  );
}

export function dropSealedReply(reply: unknown): void {
  const { cancel } = (reply ?? {}) as Partial<RealmTransportResponse>;
  if (typeof cancel !== 'function') return;
  void Promise.resolve()
    .then(() => cancel.call(reply))
    .catch(() => undefined);
}

function failed(reason: unknown): PlaceholderRefused {
  const text = reason instanceof Error ? reason.message : String(reason);
  return new PlaceholderRefused(
    `refused: the request with a sealed placeholder was not completed: ${text}`
  );
}

class Stall {
  private readonly idle = new AbortController();
  private readonly ms: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal;

  constructor(signals: AbortSignal[], ms: number) {
    this.ms = ms;
    this.signal = AbortSignal.any([...signals, this.idle.signal]);
  }

  arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.idle.abort('timeout'), this.ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  touch(): void {
    if (this.timer !== undefined) this.arm();
  }

  rest(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

async function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const stopped = Promise.withResolvers<never>();
  const stop = () => stopped.reject(signal.reason);
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([work, stopped.promise]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

async function* ticking(
  stream: AsyncIterable<Uint8Array>,
  stall: Stall
): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    stall.touch();
    yield chunk;
  }
}

function sealedRequest(
  request: RealmTransportRequest,
  stamp: SealedCaller,
  stall: Stall
): SealedFetchRequest {
  const { method, url, headers, body, bodyStream } = request;
  return {
    v: 1,
    caller: structuredClone(stamp),
    method,
    url,
    headers: headers.map(([name, value]) => [name, value] as const),
    redirect: 'manual',
    ...(bodyStream ? { bodyStream: ticking(bodyStream, stall) } : body ? { body } : {}),
  };
}

function guarded(reply: RealmTransportResponse, stall: Stall): RealmTransportResponse {
  let finished = false;
  const cancel = async () => {
    stall.signal.removeEventListener('abort', dropped);
    stall.rest();
    if (finished) return;
    finished = true;
    await reply.cancel().catch(() => undefined);
  };
  const dropped = () => void cancel();
  stall.signal.addEventListener('abort', dropped, { once: true });
  const source = reply.body[Symbol.asyncIterator]();
  const body = (async function* () {
    try {
      for (;;) {
        stall.arm();
        const next = await until(source.next(), stall.signal);
        stall.rest();
        if (next.done) {
          finished = true;
          return;
        }
        if (!(next.value instanceof Uint8Array)) throw failed('a body chunk is not bytes');
        if (next.value.byteLength > 0) yield next.value;
      }
    } finally {
      await cancel();
    }
  })();
  return {
    ...(reply.url !== undefined ? { url: reply.url } : {}),
    status: reply.status,
    statusText: reply.statusText,
    headers: reply.headers,
    body,
    cancel,
  };
}

export function sealedFetcher(
  hook: SealedFetchHook,
  stop: AbortSignal,
  idleMs = BODY_IDLE_MS
): (request: RealmTransportRequest, stamp: SealedCaller) => Promise<RealmTransportResponse> {
  return async (request, stamp) => {
    const stall = new Stall([request.signal, stop], idleMs);
    const { signal } = stall;
    if (signal.aborted) throw failed(signal.reason);
    stall.arm();
    const asked = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return hook(sealedRequest(request, stamp, stall), { signal });
    });
    let reply: unknown;
    try {
      reply = await until(asked, signal);
    } catch (e) {
      void asked.then(dropSealedReply, () => undefined);
      throw failed(e);
    } finally {
      stall.rest();
    }
    if (sealedReplyValid(reply)) return guarded(reply, stall);
    dropSealedReply(reply);
    throw failed('the reply is not a scrubbed response');
  };
}
