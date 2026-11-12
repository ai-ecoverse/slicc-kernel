import type { KernelLink, ProcessLink } from './link.ts';

export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'close', handler: (event: { data?: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

type Frame =
  | { link: 'post'; message: unknown }
  | { link: 'call'; id: number; message: unknown }
  | { link: 'reply'; id: number; value: unknown }
  | { link: 'reply'; id: number; error: string }
  | { link: 'close'; reason: string };

export interface MessageLinks {
  process: ProcessLink;
  kernel: KernelLink;
  close(reason?: string): void;
}

const LINK_CLOSED = 'link closed';

function isFrame(data: unknown): data is Frame {
  return typeof data === 'object' && data !== null && typeof (data as Frame).link === 'string';
}

export function messageLinks(port: MessagePortLike): MessageLinks {
  const posts: Array<(message: unknown) => void> = [];
  const closes: Array<(reason: string) => void> = [];
  const early: unknown[] = [];
  const earlyCalls: Array<{ id: number; message: unknown }> = [];
  const waiting = new Map<number, PromiseWithResolvers<unknown>>();
  let answer: ((message: unknown) => Promise<unknown>) | undefined;
  let next = 0;
  let ended: string | undefined;

  const send = (frame: Frame, transfer?: Transferable[]): boolean => {
    if (ended !== undefined) return false;
    try {
      if (transfer && transfer.length > 0) port.postMessage(frame, transfer);
      else port.postMessage(frame);
      return true;
    } catch (err) {
      finish(`post failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const finish = (reason: string): void => {
    if (ended !== undefined) return;
    ended = reason;
    for (const pending of waiting.values()) pending.reject(new Error(`${LINK_CLOSED}: ${reason}`));
    waiting.clear();
    try {
      port.close?.();
    } catch {}
    for (const handler of closes.splice(0)) handler(reason);
  };

  const serve = (id: number, message: unknown): void => {
    const handler = answer as (message: unknown) => Promise<unknown>;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(handler(message));
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      (value) => send({ link: 'reply', id, value }),
      (err) => send({ link: 'reply', id, error: err instanceof Error ? err.message : String(err) })
    );
  };

  const deliver = (message: unknown): void => {
    if (posts.length === 0) {
      early.push(message);
      return;
    }
    for (const handler of [...posts]) handler(message);
  };

  port.addEventListener('message', (event) => {
    const data = event.data;
    if (ended !== undefined || !isFrame(data)) return;
    switch (data.link) {
      case 'post':
        deliver(data.message);
        return;
      case 'call':
        if (answer) serve(data.id, data.message);
        else earlyCalls.push({ id: data.id, message: data.message });
        return;
      case 'reply': {
        const pending = waiting.get(data.id);
        if (!pending) return;
        waiting.delete(data.id);
        if ('error' in data) pending.reject(new Error(data.error));
        else pending.resolve(data.value);
        return;
      }
      case 'close':
        finish(data.reason);
        return;
    }
  });
  port.addEventListener('close', () => finish('port closed'));
  port.start?.();

  const onPosts = (handler: (message: unknown) => void): void => {
    posts.push(handler);
    for (const message of early.splice(0)) for (const each of [...posts]) each(message);
  };
  const onClose = (handler: (reason: string) => void): void => {
    if (ended !== undefined) {
      const reason = ended;
      queueMicrotask(() => handler(reason));
    } else closes.push(handler);
  };
  const post = (message: unknown, transfer?: Transferable[]): void => {
    send({ link: 'post', message }, transfer);
  };
  const close = (reason = 'closed'): void => {
    send({ link: 'close', reason });
    finish(reason);
  };

  const process: ProcessLink = {
    post,
    onPost: onPosts,
    onCall(handler) {
      answer = handler;
      for (const { id, message } of earlyCalls.splice(0)) serve(id, message);
    },
    onClose,
    close: () => close(),
  };
  const kernel: KernelLink = {
    post,
    call(message, transfer) {
      if (ended !== undefined) return Promise.reject(new Error(`${LINK_CLOSED}: ${ended}`));
      const id = ++next;
      const pending = Promise.withResolvers<unknown>();
      waiting.set(id, pending);
      send({ link: 'call', id, message }, transfer);
      return pending.promise;
    },
    onMessage: onPosts,
    onClose,
    close: () => close(),
  };
  return { process, kernel, close };
}
