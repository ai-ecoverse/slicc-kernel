import type { ConnectorStamp } from '../kernel/socket.ts';
import type { FacadeConnection, FacadeHook, FacadeOpenRequest } from './types.ts';

export interface FacadePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

type FacadeWire = { open: true } | { error: string } | { b: Uint8Array } | { close: true };

export interface FacadeOpen {
  facadeOpen: FacadeOpenRequest & { registration?: number };
  port: FacadePortLike;
}

export const FACADE_GONE = 'the facade host is gone';

export function serveFacadePort(
  port: FacadePortLike,
  hook: FacadeHook,
  { name, stamp }: FacadeOpenRequest,
  onDone?: () => void
): () => void {
  let conn: FacadeConnection | undefined;
  let done = false;
  const end = () => {
    done = true;
    port.close();
    onDone?.();
  };
  const finish = () => {
    if (done) return;
    port.postMessage({ close: true });
    end();
  };
  port.addEventListener('message', ({ data }: MessageEvent<{ b?: Uint8Array; close?: true }>) => {
    if (data.b !== undefined) conn?.send(data.b);
    else if (data.close && !done) {
      end();
      conn?.close();
    }
  });
  port.start?.();
  new Promise<FacadeConnection>((resolve) => resolve(hook(stamp, { name }))).then(
    (opened) => {
      conn = opened;
      if (done) return opened.close();
      opened.onmessage = (bytes) => {
        if (done) return;
        const copy = bytes.slice();
        port.postMessage({ b: copy }, [copy.buffer]);
      };
      opened.onclose = () => finish();
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
    finish();
  };
}

export function portFacadeHook(
  ask: (request: FacadeOpenRequest, port: FacadePortLike) => void,
  gone?: Promise<unknown>
): FacadeHook {
  return (stamp: ConnectorStamp, { name }) =>
    new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      let closed = false;
      const shut = () => {
        closed = true;
        port1.close();
      };
      const conn: FacadeConnection = {
        send: (bytes) => {
          if (closed) return;
          const copy = bytes.slice();
          port1.postMessage({ b: copy }, [copy.buffer]);
        },
        onmessage: null,
        onclose: null,
        close: () => {
          if (closed) return;
          port1.postMessage({ close: true });
          shut();
        },
      };
      port1.addEventListener('message', ({ data }: MessageEvent<FacadeWire>) => {
        if ('b' in data) conn.onmessage?.(data.b);
        else if ('open' in data) resolve(conn);
        else if ('error' in data) {
          shut();
          reject(new Error(data.error));
        } else if (!closed) {
          shut();
          conn.onclose?.();
        }
      });
      port1.start();
      void gone?.then(() => {
        if (closed) return;
        shut();
        reject(new Error(FACADE_GONE));
        conn.onclose?.(FACADE_GONE);
      });
      ask({ name, stamp }, port2 as unknown as FacadePortLike);
    });
}
