import {
  CLIPBOARD_TIMEOUT_MS,
  type ClipboardHook,
  type ClipboardStamp,
} from './kernel/clipboard.ts';

export interface ClipboardPort {
  postMessage(message: unknown): void;
}

export interface ClipboardAsk {
  id: number;
  op: 'read' | 'write';
  text?: string;
  stamp: ClipboardStamp;
}

export interface ClipboardReply {
  id: number;
  text?: string;
  error?: { name: string; message: string };
}

export function clipboardAsker(port: ClipboardPort): {
  hook: ClipboardHook;
  answer(reply: ClipboardReply): void;
} {
  const asks = new Map<number, PromiseWithResolvers<string | undefined>>();
  let next = 0;
  const ask = (op: 'read' | 'write', stamp: ClipboardStamp, text?: string) => {
    const id = ++next;
    const waiting = Promise.withResolvers<string | undefined>();
    asks.set(id, waiting);
    const timer = setTimeout(() => {
      if (asks.delete(id)) waiting.reject(new Error('clipboard timed out'));
    }, CLIPBOARD_TIMEOUT_MS + 1000);
    port.postMessage({ clipboardAsk: { id, op, stamp, ...(text !== undefined ? { text } : {}) } });
    return waiting.promise.finally(() => clearTimeout(timer));
  };
  const hook: ClipboardHook = {
    read: async (stamp) => (await ask('read', stamp)) ?? '',
    write: async (text, stamp) => {
      await ask('write', stamp, text);
    },
  };
  const answer = ({ id, text, error }: ClipboardReply) => {
    const waiting = asks.get(id);
    if (!waiting) return;
    asks.delete(id);
    if (error) waiting.reject(Object.assign(new Error(error.message), { name: error.name }));
    else waiting.resolve(text);
  };
  return { hook, answer };
}

export function clipboardAnswerer(
  port: ClipboardPort,
  hook: ClipboardHook | undefined
): { handle(data: unknown): boolean } {
  const ask = async ({ id, op, text, stamp }: ClipboardAsk): Promise<void> => {
    try {
      if (!hook) throw new Error('no clipboard in this embedder');
      if (op === 'read') {
        const got = await hook.read(stamp);
        if (typeof got !== 'string') throw new Error('the clipboard gave no text');
        port.postMessage({ clipboardReply: { id, text: got } });
      } else {
        await hook.write(text ?? '', stamp);
        port.postMessage({ clipboardReply: { id } });
      }
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      const message = err instanceof Error ? err.message : String(err);
      port.postMessage({
        clipboardReply: { id, error: { name: typeof name === 'string' ? name : 'Error', message } },
      });
    }
  };
  return {
    handle(data) {
      const message = data as { clipboardAsk?: ClipboardAsk } | null;
      if (!message?.clipboardAsk) return false;
      void ask(message.clipboardAsk);
      return true;
    },
  };
}
