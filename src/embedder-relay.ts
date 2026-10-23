import type {
  EmbedderHook,
  EmbedderKindPolicy,
  EmbedderReply,
  EmbedderStamp,
} from './kernel/embedder.ts';

export interface EmbedderPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

type Kinds = Readonly<Record<string, EmbedderKindPolicy>>;

export interface EmbedderAsk {
  id: number;
  client: number;
  kind: string;
  options: Record<string, unknown>;
  stamp: EmbedderStamp;
}

export type EmbedderToPage =
  | { ask: EmbedderAsk }
  | { id: number; body: Uint8Array }
  | { id: number; bodyEnd: true }
  | { id: number; pull: true }
  | { id: number; cancel: string };

export type EmbedderToKernel =
  | { id: number; ready: true }
  | { id: number; chunk: Uint8Array }
  | { id: number; done: true }
  | { id: number; error: { name: string; message: string } }
  | { id: number; progress: string }
  | { id: number; bodyPull: true }
  | { id: number; bodyCancel: true };

function fresh(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

function errorOf(err: unknown): { name: string; message: string } {
  const name = (err as { name?: unknown } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  return { name: typeof name === 'string' ? name : 'Error', message };
}

interface Asked {
  ready: PromiseWithResolvers<void>;
  chunks: Array<Uint8Array | null | { name: string; message: string }>;
  wake: (() => void) | undefined;
  body: ReadableStreamDefaultReader<Uint8Array>;
  progress(line: string): void;
}

export function embedderAsker(port: EmbedderPort) {
  const asks = new Map<number, Asked>();
  let next = 0;
  const post = (message: EmbedderToPage, transfer: Transferable[] = []) =>
    port.postMessage({ embedder: message }, transfer);
  const push = (asked: Asked, item: Asked['chunks'][number]) => {
    asked.chunks.push(item);
    asked.wake?.();
  };
  const reply = (id: number, asked: Asked) =>
    new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (asked.chunks.length === 0) {
            post({ id, pull: true });
            await new Promise<void>((resolve) => {
              asked.wake = resolve;
            });
          }
          const item = asked.chunks.shift();
          if (item instanceof Uint8Array) controller.enqueue(item);
          else if (item === null || item === undefined) {
            asks.delete(id);
            controller.close();
          } else {
            asks.delete(id);
            controller.error(Object.assign(new Error(item.message), { name: item.name }));
          }
        },
        cancel: (reason) => {
          asks.delete(id);
          post({ id, cancel: String(reason ?? 'closed') });
        },
      },
      { highWaterMark: 0 }
    );
  const sendBody = async (id: number, asked: Asked) => {
    const got = await asked.body.read().catch(() => ({ done: true as const, value: undefined }));
    if (got.done) post({ id, bodyEnd: true });
    else {
      const bytes = fresh(got.value);
      post({ id, body: bytes }, [bytes.buffer as ArrayBuffer]);
    }
  };
  const hookFor = (client: number, kinds: Kinds): EmbedderHook => ({
    kinds,
    handle: async (request) => {
      const id = ++next;
      const asked: Asked = {
        ready: Promise.withResolvers<void>(),
        chunks: [],
        wake: undefined,
        body: request.body.getReader(),
        progress: request.progress,
      };
      asks.set(id, asked);
      const cancel = () => {
        asks.delete(id);
        post({
          id,
          cancel: String((request.signal.reason as Error | undefined)?.message ?? 'closed'),
        });
        asked.ready.reject(request.signal.reason);
        push(asked, { name: 'AbortError', message: 'cancelled' });
      };
      request.signal.addEventListener('abort', cancel, { once: true });
      const { kind, options, stamp } = request;
      post({ ask: { id, client, kind, options, stamp } });
      await asked.ready.promise;
      return reply(id, asked);
    },
  });
  const answer = (message: EmbedderToKernel): void => {
    const asked = asks.get(message.id);
    if (!asked) return;
    if ('ready' in message) asked.ready.resolve();
    else if ('chunk' in message) push(asked, message.chunk);
    else if ('done' in message) push(asked, null);
    else if ('error' in message) {
      asked.ready.reject(
        Object.assign(new Error(message.error.message), { name: message.error.name })
      );
      asks.delete(message.id);
      void asked.body.cancel(message.error.message).catch(() => undefined);
      push(asked, message.error);
    } else if ('progress' in message) asked.progress(message.progress);
    else if ('bodyCancel' in message) void asked.body.cancel('the page').catch(() => undefined);
    else void sendBody(message.id, asked);
  };
  return { hookFor, answer };
}

function bytesOf(reply: EmbedderReply): ReadableStream<Uint8Array> {
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

interface Answering {
  abort: AbortController;
  body: Array<Uint8Array | null>;
  wakeBody: (() => void) | undefined;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

function bodyStream(id: number, state: Answering, post: (m: EmbedderToKernel) => void) {
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        if (state.body.length === 0) post({ id, bodyPull: true });
        while (state.body.length === 0 && !state.abort.signal.aborted) {
          await new Promise<void>((resolve) => {
            state.wakeBody = resolve;
          });
        }
        const next = state.body.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel: () => post({ id, bodyCancel: true }),
    },
    { highWaterMark: 0 }
  );
}

export function embedderAnswerer(
  port: EmbedderPort,
  hookFor: (client: number) => EmbedderHook | undefined
): { handle(data: unknown): boolean } {
  const running = new Map<number, Answering>();
  const post = (message: EmbedderToKernel, transfer: Transferable[] = []) =>
    port.postMessage({ embedderReply: message }, transfer);
  const fail = (id: number, err: unknown) => {
    running.delete(id);
    post({ id, error: errorOf(err) });
  };
  const start = async (ask: EmbedderAsk) => {
    const state: Answering = { abort: new AbortController(), body: [], wakeBody: undefined };
    running.set(ask.id, state);
    try {
      const hook = hookFor(ask.client);
      if (!hook || !Object.hasOwn(hook.kinds, ask.kind))
        throw Object.assign(new Error(`this page does not answer ${ask.kind}`), {
          name: 'NotSupportedError',
        });
      const reply = await hook.handle({
        kind: ask.kind,
        options: ask.options,
        body: bodyStream(ask.id, state, post),
        stamp: ask.stamp,
        signal: state.abort.signal,
        progress: (line) => post({ id: ask.id, progress: String(line) }),
      });
      state.reader = bytesOf(reply).getReader();
      post({ id: ask.id, ready: true });
    } catch (err) {
      fail(ask.id, err);
    }
  };
  const pull = async (id: number, state: Answering) => {
    try {
      const got = await (state.reader as ReadableStreamDefaultReader<Uint8Array>).read();
      if (got.done) {
        running.delete(id);
        post({ id, done: true });
        return;
      }
      const bytes = fresh(got.value);
      post({ id, chunk: bytes }, [bytes.buffer as ArrayBuffer]);
    } catch (err) {
      fail(id, err);
    }
  };
  const step = (message: Exclude<EmbedderToPage, { ask: EmbedderAsk }>) => {
    const state = running.get(message.id);
    if (!state) return;
    if ('body' in message) state.body.push(message.body);
    else if ('bodyEnd' in message) state.body.push(null);
    else if ('pull' in message) void pull(message.id, state);
    else {
      running.delete(message.id);
      state.abort.abort(new DOMException(message.cancel, 'AbortError'));
      void state.reader?.cancel(message.cancel).catch(() => undefined);
    }
    state.wakeBody?.();
  };
  return {
    handle(data) {
      const message = (data as { embedder?: EmbedderToPage } | null)?.embedder;
      if (!message) return false;
      if ('ask' in message) void start(message.ask);
      else step(message);
      return true;
    },
  };
}

export function embedderReplyOf(data: unknown): EmbedderToKernel | undefined {
  return (data as { embedderReply?: EmbedderToKernel } | null)?.embedderReply;
}
