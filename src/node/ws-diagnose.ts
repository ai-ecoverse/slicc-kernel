import { lookup } from 'node:dns/promises';
import { isIP, type Socket, connect as tcp } from 'node:net';
import { connect as tls } from 'node:tls';
import type { RealmTransport } from '../kernel/net/transport.ts';

const PROBE_MS = 3000;
const PASSED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET']);
const NO_NAME = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'ENODATA']);

export type Diagnose = (url: string) => Promise<string | undefined>;

function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function probe(secure: boolean, host: string, port: number, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const socket: Socket = secure
      ? tls({ host, port, ...(isIP(host) ? {} : { servername: host }) })
      : tcp({ host, port });
    const done = (code: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(code);
    };
    const timer = setTimeout(() => done('ETIMEDOUT'), ms);
    socket.once(secure ? 'secureConnect' : 'connect', () => done('EPROTO'));
    socket.once('error', (e: Error) => {
      const code = codeOf(e) ?? '';
      done(PASSED.has(code) ? code : 'EPROTO');
    });
  });
}

export async function diagnose(url: string, ms = PROBE_MS): Promise<string | undefined> {
  const at = new URL(url);
  const host = at.hostname.replace(/^\[(.*)\]$/, '$1');
  const secure = at.protocol === 'wss:';
  const port = Number(at.port) || (secure ? 443 : 80);
  try {
    await lookup(host);
  } catch (e) {
    return NO_NAME.has(codeOf(e) ?? '') ? 'EAI_NONAME' : undefined;
  }
  return probe(secure, host, port, ms);
}

export function diagnosing(transport: RealmTransport, check: Diagnose = diagnose): RealmTransport {
  const open = transport.websocket;
  if (!open) return transport;
  return {
    ...transport,
    websocket: async (request) => {
      try {
        return await open(request);
      } catch (e) {
        if (request.signal.aborted || !(e instanceof Error) || codeOf(e)) throw e;
        const code = await check(request.url).catch(() => undefined);
        throw code ? Object.assign(e, { code }) : e;
      }
    },
  };
}
