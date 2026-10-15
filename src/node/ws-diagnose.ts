import { lookup } from 'node:dns/promises';
import { isIP, type Socket, connect as tcp } from 'node:net';
import { connect as tls } from 'node:tls';
import type { RealmTransport } from '../kernel/net/transport.ts';

const PROBE_MS = 3000;
const PASSED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET']);
const NO_NAME = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'ENODATA']);

export type Diagnose = (url: string, signal?: AbortSignal) => Promise<string | undefined>;

function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  let stop = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', stop));
}

function probe(
  secure: boolean,
  host: string,
  port: number,
  ms: number,
  signal: AbortSignal | undefined
): Promise<string> {
  return new Promise((resolve) => {
    const socket: Socket = secure
      ? tls({ host, port, ...(isIP(host) ? {} : { servername: host }) })
      : tcp({ host, port });
    const stop = () => done('ABORTED');
    const done = (code: string) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      socket.destroy();
      resolve(code);
    };
    const timer = setTimeout(() => done('ETIMEDOUT'), ms);
    signal?.addEventListener('abort', stop, { once: true });
    socket.once(secure ? 'secureConnect' : 'connect', () => done('EPROTO'));
    socket.once('error', (e: Error) => {
      const code = codeOf(e) ?? '';
      done(PASSED.has(code) ? code : 'EPROTO');
    });
  });
}

export async function diagnose(
  url: string,
  ms = PROBE_MS,
  signal?: AbortSignal
): Promise<string | undefined> {
  const at = new URL(url);
  const host = at.hostname.replace(/^\[(.*)\]$/, '$1');
  const secure = at.protocol === 'wss:';
  const port = Number(at.port) || (secure ? 443 : 80);
  signal?.throwIfAborted();
  try {
    await abortable(lookup(host), signal);
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    return NO_NAME.has(codeOf(e) ?? '') ? 'EAI_NONAME' : undefined;
  }
  const code = await probe(secure, host, port, ms, signal);
  signal?.throwIfAborted();
  return code;
}

const byDefault: Diagnose = (url, signal) => diagnose(url, PROBE_MS, signal);

export function diagnosing(transport: RealmTransport, check: Diagnose = byDefault): RealmTransport {
  const open = transport.websocket;
  if (!open) return transport;
  return {
    ...transport,
    get traits() {
      return transport.traits;
    },
    websocket: async (request) => {
      try {
        return await open(request);
      } catch (e) {
        if (request.signal.aborted || !(e instanceof Error) || codeOf(e)) throw e;
        const code = await abortable(
          check(request.url, request.signal).catch(() => undefined),
          request.signal
        );
        request.signal.throwIfAborted();
        throw code ? Object.assign(e, { code }) : e;
      }
    },
  };
}
