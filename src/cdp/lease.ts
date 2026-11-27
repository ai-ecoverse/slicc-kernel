import type { ConnectorStamp } from '../kernel/socket.ts';
import type { CdpConnection, CdpHook } from './types.ts';

export const CDP_LEASE_VERSION = 1;
export const LEASE_MAX_MESSAGE = 128 * 1024;

interface LeaseRule {
  kind: 'origin' | 'exact' | 'path-prefix';
  url: string;
}

export type CdpLeaseRequest = { allow: LeaseRule[]; reason?: string } & (
  | { ttlSeconds: number; lease?: never }
  | { lease: string; ttlSeconds?: never }
);

export type CdpLeaseAction = { lease: string } & (
  | { op: 'goto'; args: { url: string } }
  | { op: 'snapshot'; args: Record<string, never> }
);

export interface CdpLeaseContext {
  stamp: ConnectorStamp;
  signal: AbortSignal;
}

export interface CdpLeaseAdapter {
  request(
    params: CdpLeaseRequest,
    context: CdpLeaseContext
  ): Promise<{
    request: string;
    lease: string;
    jkt: string;
  }>;
  action(
    params: CdpLeaseAction,
    context: CdpLeaseContext
  ): Promise<{
    result: Record<string, never> | { text: string };
  }>;
}

export interface CdpLeaseOptions {
  tag: string;
  adapter: CdpLeaseAdapter;
}

const BOOT_FIELDS = {
  browser: new Set(['cdpLease', 'metadata', 'media', 'ca']),
  node: new Set(['cdpLease']),
  cloudflare: new Set(['cdpLease', 'loader']),
};

export function checkedLease(
  options: { cdpLease?: CdpLeaseOptions },
  host: keyof typeof BOOT_FIELDS
): CdpLeaseOptions | undefined {
  const lease = options.cdpLease;
  if (lease === undefined) return undefined;
  if (
    typeof lease?.tag !== 'string' ||
    Reflect.ownKeys(lease).some((k) => k !== 'tag' && k !== 'adapter') ||
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(lease.tag) ||
    typeof lease.adapter?.request !== 'function' ||
    typeof lease.adapter?.action !== 'function'
  ) {
    throw new TypeError('cdpLease requires one job tag and a request/action adapter');
  }
  if (
    Object.getPrototypeOf(options) !== Object.prototype ||
    Reflect.ownKeys(options).some((k) => typeof k !== 'string' || !BOOT_FIELDS[host].has(k))
  ) {
    throw new TypeError('unexpected boot option for a lease-only kernel');
  }
  return { tag: lease.tag, adapter: lease.adapter };
}

export const LEASE_MAX_CONNECTIONS = 8;

const ERRORS = new Map([
  ['E_PENDING', 'Waiting for the owner.'],
  ['E_SCOPE', 'Outside the approved lease.'],
  ['E_EXPIRED', 'The lease expired.'],
  ['E_REVOKED', 'The lease is no longer active.'],
  ['E_DENIED', 'The owner declined the request.'],
  ['E_UNSUPPORTED', 'Lease operation unavailable.'],
  ['E_REPLACED', 'The lease was replaced.'],
  ['E_STALE', 'The element reference is stale.'],
  ['E_UNAVAILABLE', 'No job-scoped adapter is available.'],
  ['E_OUTCOME_UNKNOWN', 'The action may have taken effect. Do not automatically retry.'],
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fields(obj: Record<string, unknown>, ...keys: string[]): boolean {
  return Object.keys(obj).every((k) => keys.includes(k));
}
function opaque(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
}
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const n = text.charCodeAt(i);
    if (n < 32 || n === 127) return true;
  }
  return false;
}
function https(v: unknown): v is string {
  if (
    typeof v !== 'string' ||
    v.length > 8192 ||
    !v.startsWith('https://') ||
    /\s/u.test(v) ||
    v.includes('\\') ||
    hasControl(v)
  )
    return false;
  const url = URL.parse(v);
  return url !== null && !url.username && !url.password && !/^https:\/\/[^/?#]*@/.test(v);
}
function rule(v: unknown): v is LeaseRule {
  if (
    !record(v) ||
    !fields(v, 'kind', 'url') ||
    !https(v.url) ||
    /\*|%(?![0-9a-f]{2})/i.test(v.url)
  )
    return false;
  const url = new URL(v.url);
  if (v.kind === 'origin') return url.origin === v.url;
  if (url.href !== v.url || /%2f|%5c/i.test(url.pathname)) return false;
  if (v.kind === 'exact') return true;
  return (
    v.kind === 'path-prefix' &&
    url.origin + url.pathname === v.url &&
    (url.pathname === '/' || !url.pathname.endsWith('/'))
  );
}
function request(p: Record<string, unknown>): p is CdpLeaseRequest {
  return (
    fields(p, 'allow', 'ttlSeconds', 'lease', 'reason') &&
    Array.isArray(p.allow) &&
    p.allow.length > 0 &&
    p.allow.length <= 64 &&
    p.allow.every(rule) &&
    new Set(p.allow.map(({ kind, url }) => `${kind}:${url}`)).size === p.allow.length &&
    (p.lease === undefined
      ? Number.isSafeInteger(p.ttlSeconds) && (p.ttlSeconds as number) > 0
      : opaque(p.lease) && p.ttlSeconds === undefined) &&
    (p.reason === undefined ||
      (typeof p.reason === 'string' && p.reason.length > 0 && p.reason.length <= 1024))
  );
}
function action(p: Record<string, unknown>): p is CdpLeaseAction {
  if (!fields(p, 'lease', 'op', 'args') || !opaque(p.lease) || !record(p.args)) return false;
  const a = p.args;
  switch (p.op) {
    case 'goto':
      return fields(a, 'url') && https(a.url);
    case 'snapshot':
      return fields(a);
    default:
      return false;
  }
}

async function dispatch(
  adapter: CdpLeaseAdapter,
  ctx: CdpLeaseContext,
  method: unknown,
  p: unknown
) {
  if (record(p) && method === 'Slicc.leaseRequest' && request(p)) {
    const reply = await adapter.request(p, ctx);
    if (
      opaque(reply.request) &&
      opaque(reply.lease) &&
      typeof reply.jkt === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(reply.jkt)
    ) {
      return { request: reply.request, lease: reply.lease, jkt: reply.jkt };
    }
  }
  if (record(p) && method === 'Slicc.leaseAction' && action(p)) {
    let result: unknown;
    try {
      ({ result } = await adapter.action(p, ctx));
    } catch (err) {
      if (record(err) && typeof err.reason === 'string' && ERRORS.has(err.reason)) throw err;
      throw { reason: 'E_OUTCOME_UNKNOWN' };
    }
    if (record(result)) {
      if (p.op !== 'snapshot' && fields(result)) return { result: {} };
      if (
        p.op === 'snapshot' &&
        fields(result, 'text') &&
        typeof result.text === 'string' &&
        result.text.length <= 65536
      )
        return { result: { text: result.text } };
    }
    throw { reason: 'E_OUTCOME_UNKNOWN' };
  }
  throw new Error();
}

async function reply(
  adapter: CdpLeaseAdapter,
  ctx: CdpLeaseContext,
  message: string,
  busy: boolean
) {
  let id: number | null = null;
  try {
    const cmd: unknown = JSON.parse(message);
    if (!record(cmd) || !Number.isSafeInteger(cmd.id) || (cmd.id as number) < 1) throw new Error();
    id = cmd.id as number;
    if (!fields(cmd, 'id', 'method', 'params')) throw new Error();
    if (busy) throw { reason: 'E_UNAVAILABLE' };
    const result = await dispatch(adapter, ctx, cmd.method, cmd.params);
    const text = JSON.stringify({ id, result });
    if (new TextEncoder().encode(text).length > LEASE_MAX_MESSAGE) throw new Error();
    return text;
  } catch (err) {
    const reason =
      record(err) && typeof err.reason === 'string' && ERRORS.has(err.reason)
        ? err.reason
        : 'E_UNSUPPORTED';
    return JSON.stringify({
      id,
      error: { code: -32000, message: ERRORS.get(reason), data: { reason } },
    });
  }
}

export function leaseHook({ tag, adapter }: CdpLeaseOptions): CdpHook {
  let pending = 0;
  return async ({ stamp }) => {
    if (!stamp || stamp.tag !== tag) throw new Error('lease unavailable');
    const stop = new AbortController();
    const conn: CdpConnection = {
      onmessage: null,
      onclose: null,
      send(message) {
        if (stop.signal.aborted) return;
        const busy = pending >= LEASE_MAX_CONNECTIONS;
        pending++;
        void reply(
          adapter,
          { stamp: structuredClone(stamp), signal: stop.signal },
          message,
          busy
        ).then((text) => {
          pending--;
          if (!stop.signal.aborted) conn.onmessage?.(text);
        });
      },
      close: () => stop.abort(),
    };
    return conn;
  };
}
