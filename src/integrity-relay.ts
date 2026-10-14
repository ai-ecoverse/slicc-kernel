import type { IntegrityLookup } from './fs/integrity.ts';

export interface IntegrityPort {
  postMessage(message: unknown): void;
}

export interface IntegrityAsk {
  id: number;
  path: string;
}

export interface IntegrityReply {
  id: number;
  hash?: string;
  error?: string;
}

export function integrityAsker(port: IntegrityPort): {
  lookup: IntegrityLookup;
  answer(reply: IntegrityReply): void;
} {
  const asks = new Map<number, PromiseWithResolvers<string | undefined>>();
  let next = 0;
  const lookup: IntegrityLookup = (path) => {
    const id = ++next;
    const waiting = Promise.withResolvers<string | undefined>();
    asks.set(id, waiting);
    port.postMessage({ integrityAsk: { id, path } });
    return waiting.promise;
  };
  const answer = ({ id, hash, error }: IntegrityReply) => {
    const waiting = asks.get(id);
    if (!waiting) return;
    asks.delete(id);
    if (error !== undefined) waiting.reject(new Error(error));
    else waiting.resolve(hash);
  };
  return { lookup, answer };
}

export function integrityAnswerer(
  port: IntegrityPort,
  lookup: IntegrityLookup | undefined
): (data: unknown) => boolean {
  const ask = async ({ id, path }: IntegrityAsk): Promise<void> => {
    try {
      const hash = lookup ? await lookup(path) : undefined;
      port.postMessage({ integrityReply: { id, ...(typeof hash === 'string' ? { hash } : {}) } });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      port.postMessage({ integrityReply: { id, error } });
    }
  };
  return (data) => {
    const asked = (data as { integrityAsk?: IntegrityAsk } | null)?.integrityAsk;
    if (!asked) return false;
    void ask(asked);
    return true;
  };
}
