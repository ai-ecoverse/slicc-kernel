import type { CdpConnection, CdpHook, CdpRequest } from './types.ts';

export interface CdpPortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

export type CdpWire = { open: true } | { error: string } | { m: string } | { close: string | null };

export interface CdpOpen {
  cdpOpen: CdpRequest & { registration?: number };
  port: CdpPortLike;
}

export function serveCdpPort(
  port: CdpPortLike,
  hook: CdpHook,
  request: CdpRequest,
  onDone?: () => void
): () => void {
  let conn: CdpConnection | undefined;
  let done = false;
  const end = () => {
    done = true;
    port.close();
    onDone?.();
  };
  const finish = (reason: string | null) => {
    if (done) return;
    port.postMessage({ close: reason });
    end();
  };
  port.addEventListener('message', ({ data }: MessageEvent<{ m?: string; close?: true }>) => {
    if (data.m !== undefined) conn?.send(data.m);
    else if (data.close && !done) {
      end();
      conn?.close();
    }
  });
  port.start?.();
  new Promise<CdpConnection>((resolve) => resolve(hook(request))).then(
    (opened) => {
      conn = opened;
      if (done) return opened.close();
      opened.onmessage = (m) => {
        if (!done) port.postMessage({ m });
      };
      opened.onclose = (reason) => finish(reason ?? null);
      port.postMessage({ open: true });
    },
    (e: unknown) => {
      if (done) return;
      port.postMessage({ error: e instanceof Error ? e.message : String(e) });
      end();
    }
  );
  return () => {
    if (done) return;
    conn?.close();
    finish('the CDP host is gone');
  };
}

export function portCdpHook(
  ask: (request: CdpRequest, port: CdpPortLike) => void,
  gone?: Promise<unknown>
): CdpHook {
  return (request) =>
    new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      let closed = false;
      const conn: CdpConnection = {
        send: (m) => {
          if (!closed) port1.postMessage({ m });
        },
        onmessage: null,
        onclose: null,
        close: () => {
          if (closed) return;
          closed = true;
          port1.postMessage({ close: true });
          port1.close();
        },
      };
      port1.addEventListener('message', ({ data }: MessageEvent<CdpWire>) => {
        if ('m' in data) conn.onmessage?.(data.m);
        else if ('open' in data) resolve(conn);
        else if ('error' in data) {
          closed = true;
          port1.close();
          reject(new Error(data.error));
        } else if (!closed) {
          closed = true;
          port1.close();
          conn.onclose?.(data.close ?? undefined);
        }
      });
      port1.start();
      void gone?.then(() => {
        if (closed) return;
        closed = true;
        port1.close();
        reject(new Error('the CDP host is gone'));
        conn.onclose?.('the CDP host is gone');
      });
      ask(request, port2 as unknown as CdpPortLike);
    });
}
