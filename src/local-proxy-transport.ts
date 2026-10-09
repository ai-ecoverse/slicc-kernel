import { BODY_IDLE_MS, readWithin } from './body-idle.ts';
import type {
  HeaderList,
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
} from './kernel/net/transport.ts';

export interface LocalProxyOptions {
  url: string;
  key: string;
  fetch?: typeof globalThis.fetch;
}

export interface LocalProxyCheckOptions extends LocalProxyOptions {
  permissions?: Pick<Permissions, 'query'>;
}

export interface LocalProxyTransportOptions extends LocalProxyOptions {
  maxRequestBody?: number;
  bodyIdleMs?: number;
}

export interface LocalProxyProbe {
  rawFetch: number;
  requestBodyStreaming: boolean;
  maxRequestBodyBytes: number;
  kernelTunnel?: number;
  kernelPort?: number;
}

export type LocalProxyStatus =
  | { state: 'ready'; probe: LocalProxyProbe }
  | { state: 'blocked' }
  | { state: 'unreachable'; permission: 'granted' | 'prompt' | 'unknown' }
  | { state: 'refused'; status: number; error: string }
  | { state: 'incompatible' };

const PATH = '/api/fetch-proxy';
const RAW_CONTENT_TYPE = 'application/vnd.slicc.raw-fetch';
const MAX_HEAD = 1024 * 1024;
const MAX_REQUEST_BODY = 64 * 1024 * 1024;
const PERMISSIONS = ['loopback-network', 'local-network-access'];
const LOOPBACK_PAGE = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/;

interface ResponseHead {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

const failure = (message: string, status = 502) =>
  Object.assign(new Error(`local proxy: ${message}`), { status });

function encodeHead(url: string, method: string, headers: HeaderList): string {
  return JSON.stringify({ url, method, headers }).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function hopHeaders(options: LocalProxyOptions, extra: Record<string, string>): Headers {
  return new Headers({ 'X-Bridge-Token': options.key, ...extra });
}

function send(options: LocalProxyOptions) {
  return options.fetch ?? globalThis.fetch.bind(globalThis);
}

async function refusalMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {}
  return text || response.statusText || `answered ${response.status}`;
}

async function refusal(response: Response): Promise<Error> {
  return failure(await refusalMessage(response), response.ok ? 502 : response.status);
}

async function permission(permissions: Pick<Permissions, 'query'> | undefined): Promise<string> {
  if (!permissions) return 'unknown';
  for (const name of PERMISSIONS) {
    try {
      return (await permissions.query({ name } as PermissionDescriptor)).state;
    } catch {}
  }
  return 'unknown';
}

function isHead(value: unknown): value is ResponseHead {
  const head = value as Partial<ResponseHead> | null;
  return (
    !!head &&
    typeof head.status === 'number' &&
    typeof head.statusText === 'string' &&
    Array.isArray(head.headers) &&
    head.headers.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string'
    )
  );
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

async function readHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number
): Promise<{ head: ResponseHead; rest: Uint8Array }> {
  let buffer: Uint8Array = new Uint8Array(0);
  for (;;) {
    if (buffer.byteLength >= 4) {
      const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
      if (length > MAX_HEAD) throw failure(`response head of ${length} bytes`);
      if (buffer.byteLength >= 4 + length) {
        let head: unknown;
        try {
          head = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length)));
        } catch {}
        if (!isHead(head)) throw failure('malformed response head');
        return { head, rest: buffer.subarray(4 + length) };
      }
    }
    const next = await readWithin(reader, idleMs);
    if (next.done) throw failure('closed before the response head');
    buffer = concat(buffer, next.value);
  }
}

async function* chunks(
  rest: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number
): AsyncGenerator<Uint8Array> {
  try {
    if (rest.byteLength > 0) yield rest;
    for (
      let next = await readWithin(reader, idleMs);
      !next.done;
      next = await readWithin(reader, idleMs)
    ) {
      if (next.value.byteLength > 0) yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function checkLocalProxy(options: LocalProxyCheckOptions): Promise<LocalProxyStatus> {
  const onLoopback = LOOPBACK_PAGE.test(globalThis.location?.hostname ?? '');
  const permissions = onLoopback
    ? undefined
    : (options.permissions ?? globalThis.navigator?.permissions);
  if ((await permission(permissions)) === 'denied') return { state: 'blocked' };
  let response: Response;
  try {
    response = await send(options)(new URL(PATH, options.url), {
      method: 'POST',
      headers: hopHeaders(options, { 'X-Slicc-Raw-Probe': '1' }),
      credentials: 'omit',
      mode: 'cors',
    });
  } catch {
    const now = await permission(permissions);
    if (now === 'denied') return { state: 'blocked' };
    return {
      state: 'unreachable',
      permission: now === 'granted' || now === 'prompt' ? now : 'unknown',
    };
  }
  if (!response.ok) {
    return { state: 'refused', status: response.status, error: await refusalMessage(response) };
  }
  const reply = (await response.json().catch(() => null)) as Partial<LocalProxyProbe> | null;
  if (
    !reply ||
    typeof reply.rawFetch !== 'number' ||
    reply.rawFetch < 1 ||
    typeof reply.requestBodyStreaming !== 'boolean' ||
    typeof reply.maxRequestBodyBytes !== 'number'
  ) {
    return { state: 'incompatible' };
  }
  return {
    state: 'ready',
    probe: {
      rawFetch: reply.rawFetch,
      requestBodyStreaming: reply.requestBodyStreaming,
      maxRequestBodyBytes: reply.maxRequestBodyBytes,
      ...(typeof reply.kernelTunnel === 'number' ? { kernelTunnel: reply.kernelTunnel } : {}),
      ...(typeof reply.kernelPort === 'number' ? { kernelPort: reply.kernelPort } : {}),
    },
  };
}

export async function probeLocalProxy(
  options: LocalProxyCheckOptions
): Promise<LocalProxyProbe | null> {
  const status = await checkLocalProxy(options);
  return status.state === 'ready' ? status.probe : null;
}

export function localProxyTransport(options: LocalProxyTransportOptions): RealmTransport {
  const endpoint = new URL(PATH, options.url);
  return {
    traits: {
      manualRedirects: true,
      encodedBodies: false,
      maxRequestBody: options.maxRequestBody ?? MAX_REQUEST_BODY,
    },
    async fetch(request: RealmTransportRequest): Promise<RealmTransportResponse> {
      let response: Response;
      try {
        response = await send(options)(endpoint, {
          method: 'POST',
          headers: hopHeaders(options, {
            'X-Slicc-Raw-Request': encodeHead(request.url, request.method, request.headers),
          }),
          ...(request.body ? { body: request.body as BodyInit } : {}),
          signal: request.signal,
          credentials: 'omit',
          mode: 'cors',
        });
      } catch (e) {
        if (request.signal.aborted) throw e;
        throw failure(`${endpoint.origin} is unreachable or refuses this origin`);
      }
      const type = response.headers.get('content-type') ?? '';
      if (response.status !== 200 || !type.startsWith(RAW_CONTENT_TYPE) || !response.body) {
        throw await refusal(response);
      }
      const reader = response.body.getReader();
      const idleMs = options.bodyIdleMs ?? BODY_IDLE_MS;
      let framed: { head: ResponseHead; rest: Uint8Array };
      try {
        framed = await readHead(reader, idleMs);
      } catch (e) {
        await reader.cancel().catch(() => undefined);
        throw e;
      }
      const body = chunks(framed.rest, reader, idleMs);
      return {
        status: framed.head.status,
        statusText: framed.head.statusText,
        headers: framed.head.headers,
        body,
        cancel: async () => {
          await body.return(undefined);
          await reader.cancel().catch(() => undefined);
        },
      };
    },
  };
}
