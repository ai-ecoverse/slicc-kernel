import type { CdpConnection } from './types.ts';

export interface HeldConnection {
  conn: CdpConnection;
  message(message: string): void;
  end(reason?: string): void;
}

export function heldConnection(send: (message: string) => void, close: () => void): HeldConnection {
  const queued: string[] = [];
  let ended: { reason: string | undefined } | undefined;
  let onmessage: CdpConnection['onmessage'] = null;
  let onclose: CdpConnection['onclose'] = null;
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    queueMicrotask(() => {
      draining = false;
      while (onmessage && queued.length > 0) onmessage(queued.shift() as string);
      if (!onclose || !ended) return;
      const { reason } = ended;
      ended = undefined;
      onclose(reason);
    });
  };
  const conn: CdpConnection = {
    send,
    close,
    get onmessage() {
      return onmessage;
    },
    set onmessage(next) {
      onmessage = next;
      if (next) drain();
    },
    get onclose() {
      return onclose;
    },
    set onclose(next) {
      onclose = next;
      if (next) drain();
    },
  };
  return {
    conn,
    message(message) {
      if (onmessage && queued.length === 0) onmessage(message);
      else queued.push(message);
    },
    end(reason) {
      ended = { reason };
      drain();
    },
  };
}
