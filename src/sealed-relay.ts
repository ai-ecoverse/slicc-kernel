import type { SealedHook, SealedRequest } from './kernel/sealed.ts';

export interface SealedPort {
  postMessage(message: unknown): void;
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

export function sealedAsker(port: SealedPort): {
  hook: SealedHook;
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
  return { hook, answer };
}

export interface SealedAnswerer {
  handle(data: unknown): boolean;
  close(): void;
}

export function sealedAnswerer(port: SealedPort, hook: SealedHook | undefined): SealedAnswerer {
  const asked = new Map<number, AbortController>();
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
      const message = data as { sealedAsk?: SealedAsk; sealedAbort?: SealedAbort } | null;
      if (message?.sealedAsk) void ask(message.sealedAsk);
      else if (message?.sealedAbort) abort(message.sealedAbort);
      else return false;
      return true;
    },
    close() {
      for (const control of asked.values()) control.abort('withdrawn');
      asked.clear();
    },
  };
}
