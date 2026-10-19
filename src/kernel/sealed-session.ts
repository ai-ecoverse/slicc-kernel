import type { SealedCaller } from './sealed.ts';

export const SESSION_WINDOW_MS = 60_000;
export const SESSION_PLACEHOLDERS = 16;
export const SESSION_PLACEHOLDER = /^fnox_proxy_[0-9a-f]{24}$/;

const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const TOKEN = "[!#$%&'*+.^_`|~0-9a-z-]+";
const HEADER = new RegExp(`^header:${TOKEN}$`);
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TARGET = /^[\x21-\x7e]+$/;
export const SESSION_EXIT = /^(page|proxy|tailscale|device:[A-Za-z0-9._-]+)$/;
const HOST = /^[a-z0-9.:-]+$/;
const UNSAFE = /[\r\n\0]/;

export type SessionProtocol = 'http1' | 'smtp' | 'pg';

export interface SessionHead {
  method: string;
  path: string;
}

export interface SessionFields {
  stamp: SealedCaller;
  session: string;
  host: string;
  port: number;
  protocol: SessionProtocol;
  position: string;
  verified: boolean;
  handshakeAt: number;
  exit: string;
  placeholders: string[];
  head?: SessionHead;
}

const POSITIONS: Readonly<Record<SessionProtocol, (position: string) => boolean>> = {
  http1: (position) => HEADER.test(position),
  smtp: (position) => position === 'auth-plain' || position === 'auth-login',
  pg: (position) => position === 'password-cleartext',
};

export function boundHost(servername: string): string {
  const lower = servername.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

function headOk(f: SessionFields): boolean {
  if (f.protocol !== 'http1') return f.head === undefined;
  const head = f.head;
  return (
    head !== undefined &&
    typeof head.method === 'string' &&
    METHOD.test(head.method) &&
    typeof head.path === 'string' &&
    TARGET.test(head.path)
  );
}

function placeholdersOk(list: unknown): boolean {
  if (!Array.isArray(list) || list.length === 0 || list.length > SESSION_PLACEHOLDERS) return false;
  return (
    new Set(list).size === list.length &&
    list.every((p) => typeof p === 'string' && SESSION_PLACEHOLDER.test(p))
  );
}

function hostOk(host: unknown): boolean {
  return typeof host === 'string' && HOST.test(host) && boundHost(host) === host;
}

export function sessionAskable(f: SessionFields, now: number): boolean {
  if (!Object.hasOwn(POSITIONS, f.protocol) || typeof f.position !== 'string') return false;
  if (!POSITIONS[f.protocol](f.position)) return false;
  if (typeof f.session !== 'string' || !SESSION_ID.test(f.session)) return false;
  if (f.verified !== true || !hostOk(f.host) || typeof f.handshakeAt !== 'number') return false;
  if (!Number.isInteger(f.port) || f.port < 1 || f.port > 65535) return false;
  const age = now - f.handshakeAt;
  if (!Number.isFinite(age) || age < 0 || age > SESSION_WINDOW_MS) return false;
  return (
    typeof f.exit === 'string' &&
    SESSION_EXIT.test(f.exit) &&
    placeholdersOk(f.placeholders) &&
    headOk(f)
  );
}

export function sessionRequest(f: SessionFields) {
  return {
    v: 1 as const,
    op: 'sessionMaterialize',
    caller: f.stamp,
    stamp: f.stamp,
    session: f.session,
    host: f.host,
    port: f.port,
    protocol: f.protocol,
    position: f.position,
    verified: true,
    handshakeAt: f.handshakeAt,
    exit: f.exit,
    placeholders: [...f.placeholders],
    ...(f.head ? { head: { method: f.head.method, path: f.head.path } } : {}),
  };
}

export function sessionValues(
  reply: unknown,
  asked: readonly string[]
): Record<string, string> | undefined {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return undefined;
  const { error, values } = reply as { error?: unknown; values?: unknown };
  if (error !== undefined || typeof values !== 'object' || values === null) return undefined;
  const out: Record<string, string> = {};
  for (const ph of asked) {
    const value = (values as Record<string, unknown>)[ph];
    if (typeof value === 'string' && value.length > 0 && !UNSAFE.test(value)) out[ph] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
