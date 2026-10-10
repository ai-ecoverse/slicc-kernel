import { type FilesystemHandlers, fsError, type OpenFlags, serveFilesystem } from './driver.ts';
import { type MediumHandlers, mediumSlot } from './medium.ts';
import type { MountSpec, OpenedDriver } from './mount-fs.ts';
import type { DriverAttr, DriverCapabilities, DriverEntry, DriverStatfs } from './protocol.ts';

export interface HostfsGrant {
  url: string;
  token: string;
  readonly?: boolean;
  capabilities?: DriverCapabilities;
}

export interface HostfsPortGrant {
  port: MessagePort;
  token?: string;
  capabilities?: DriverCapabilities;
}

export type HostfsGrantHook = (
  source: string,
  options: { readonly: boolean }
) => Promise<HostfsGrant | HostfsPortGrant>;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HostfsEvent {
  paths?: string[];
  all?: boolean;
  ping?: number;
}

export interface HostfsTransport {
  readonly capabilities: DriverCapabilities;
  readonly token: string;
  readonly maxIo: number;
  call<T>(op: string, body?: Record<string, unknown>, handle?: boolean): Promise<T>;
  read(fh: number, offset: number, size: number, ifMatch?: string): Promise<Uint8Array>;
  write(fh: number, offset: number, bytes: Uint8Array): Promise<void>;
  watch(
    signal: AbortSignal,
    onEvent: (event: HostfsEvent) => void,
    onOpen?: () => void
  ): Promise<void>;
}

export type HostfsConnect = (
  source: string,
  options: { readonly: boolean }
) => Promise<HostfsTransport>;

export const HOSTFS_IO = 16 * 1024 * 1024;

const codeOf = (err: unknown) => (err as { code?: unknown } | null)?.code;

export const unreachable = (err: unknown) => codeOf(err) === 'ENOTCONN';

function rel(path: string): string {
  return path.replace(/^\/+/, '');
}

export class HostfsClient implements HostfsTransport {
  private grant: HostfsGrant;
  private readonly regrant: () => Promise<HostfsGrant>;
  private readonly fetch: FetchLike;

  constructor(grant: HostfsGrant, regrant: () => Promise<HostfsGrant>, fetch: FetchLike) {
    this.grant = grant;
    this.regrant = regrant;
    this.fetch = fetch;
  }

  get capabilities(): DriverCapabilities {
    return this.grant.capabilities ?? {};
  }

  get token(): string {
    return this.grant.token;
  }

  get maxIo(): number {
    return this.capabilities.maxIo ?? HOSTFS_IO;
  }

  private async send(
    path: string,
    init: RequestInit,
    handle = false,
    retried = false
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(`${this.grant.url}${path}`, {
        ...init,
        credentials: 'omit',
        headers: {
          ...(init.headers as Record<string, string>),
          'X-Hostfs-Token': this.grant.token,
        },
      });
    } catch (err) {
      throw fsError('ENOTCONN', `the host proxy is unreachable: ${(err as Error).message}`);
    }
    if (response.ok) return response;
    if (response.headers.get('X-Proxy-Error')) {
      await response.body?.cancel();
      if (retried || response.status !== 403) {
        throw fsError('EACCES', `the host proxy refused this folder (${response.status})`);
      }
      this.grant = await this.regrant();
      if (handle)
        throw fsError('ESTALE', 'the folder was granted again, so its open files are gone');
      return this.send(path, init, false, true);
    }
    const errno = response.headers.get('X-Hostfs-Errno') ?? 'EIO';
    const body = (await response.json().catch(() => ({}))) as { message?: unknown };
    throw fsError(errno, typeof body.message === 'string' ? body.message : errno);
  }

  async call<T>(op: string, body: Record<string, unknown> = {}, handle = false): Promise<T> {
    const response = await this.send(
      '/api/hostfs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...body }),
      },
      handle
    );
    return (await response.json()) as T;
  }

  async read(fh: number, offset: number, size: number, ifMatch?: string): Promise<Uint8Array> {
    const response = await this.send(
      '/api/hostfs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'read', fh, offset, size, ...(ifMatch ? { ifMatch } : {}) }),
      },
      true
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async write(fh: number, offset: number, bytes: Uint8Array): Promise<void> {
    const response = await this.send(
      '/api/hostfs/write',
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Hostfs-Request': JSON.stringify({ fh, offset }),
        },
        body: bytes as BodyInit,
      },
      true
    );
    await response.body?.cancel();
  }

  async watch(
    signal: AbortSignal,
    onEvent: (event: HostfsEvent) => void,
    onOpen: () => void = () => undefined
  ): Promise<void> {
    const response = await this.send('/api/hostfs/watch', { method: 'POST', signal });
    onOpen();
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        let end = buffered.indexOf('\n');
        while (end >= 0) {
          const line = buffered.slice(0, end).trim();
          buffered = buffered.slice(end + 1);
          if (line) onEvent(JSON.parse(line) as HostfsEvent);
          end = buffered.indexOf('\n');
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      throw fsError('ENOTCONN', `the host proxy's watch broke: ${(err as Error).message}`);
    } finally {
      reader.releaseLock();
    }
  }
}

interface Remote {
  client: HostfsTransport;
  token: string;
  fh: number;
  etag: string | undefined;
  restore: { path: string; mode: number } | undefined;
}

export function hostfsHandlers(current: () => HostfsTransport): MediumHandlers {
  const handles = new Map<number, Remote>();
  let nextFh = 0;
  const fresh = (remote: Remote): Remote => {
    if (remote.client.token === remote.token) return remote;
    throw fsError('ESTALE', 'the folder was granted again, so this open file is gone');
  };
  const live = (fh: number): Remote => {
    const remote = handles.get(fh);
    if (!remote) throw fsError('EBADF', `handle ${fh}`);
    return fresh(remote);
  };
  const call = <T>(op: string, body: Record<string, unknown> = {}) => current().call<T>(op, body);
  async function writable(client: HostfsTransport, path: string, flags: OpenFlags) {
    const { ifMatch: _, ...asked } = flags;
    const opening = () =>
      client.call<{ fh: number; attr?: DriverAttr }>('open', { path: rel(path), ...asked });
    try {
      return { opened: await opening(), restore: undefined };
    } catch (err) {
      if (!flags.write || codeOf(err) !== 'EACCES') throw err;
      const mode = (await client.call<DriverAttr>('stat', { path: rel(path) })).mode ?? 0;
      if (mode & 0o200) throw err;
      const restore = { path: rel(path), mode };
      await client.call('setattr', { path: rel(path), mode: mode | 0o200 });
      const opened = await opening().catch(async (again: unknown) => {
        await client.call('setattr', restore);
        throw again;
      });
      return { opened, restore };
    }
  }
  const handlers: MediumHandlers = {
    getattr: async (path) => await call<DriverAttr>('stat', { path: rel(path) }),
    async readdir(path) {
      const { entries } = await call<{ entries: Array<{ name: string; attr: DriverAttr }> }>(
        'list',
        { path: rel(path) }
      );
      return entries.map(({ name, attr }): DriverEntry => ({ name, kind: attr.kind, attr }));
    },
    async open(path: string, flags: OpenFlags) {
      const client = current();
      const token = client.token;
      const { opened, restore } = await writable(client, path, flags);
      if (flags.ifMatch !== undefined && opened.attr?.etag !== flags.ifMatch) {
        await client.call('release', { fh: opened.fh }, true);
        throw fsError('ESTALE', `${path} changed on the host while it was being read`);
      }
      handles.set(++nextFh, {
        client,
        token,
        fh: opened.fh,
        etag: flags.write ? undefined : opened.attr?.etag,
        restore,
      });
      return nextFh;
    },
    async read(fh, offset, size) {
      const remote = live(fh);
      return remote.client.read(
        remote.fh,
        offset,
        Math.min(size, remote.client.maxIo),
        remote.etag
      );
    },
    async write(fh, offset, bytes) {
      const remote = live(fh);
      const most = remote.client.maxIo;
      for (let at = 0; at < bytes.length; at += most) {
        await remote.client.write(remote.fh, offset + at, bytes.subarray(at, at + most));
      }
    },
    async release(fh) {
      const remote = handles.get(fh);
      if (!remote) throw fsError('EBADF', `handle ${fh}`);
      handles.delete(fh);
      try {
        await fresh(remote).client.call('release', { fh: remote.fh }, true);
      } finally {
        if (remote.restore) await current().call('setattr', remote.restore);
      }
    },
    mkdir: async (path) => void (await call('mkdir', { path: rel(path) })),
    rmdir: async (path) => void (await call('rmdir', { path: rel(path) })),
    unlink: async (path) => void (await call('unlink', { path: rel(path) })),
    rename: async (from, to) => void (await call('rename', { from: rel(from), to: rel(to) })),
    symlink: async (target, path) => void (await call('symlink', { target, path: rel(path) })),
    readlink: async (path) =>
      (await call<{ target: string }>('readlink', { path: rel(path) })).target,
    async setattr(path, { size, ...change }) {
      if (size !== undefined && !current().capabilities.ranges) await resize(handlers, path, size);
      else if (size !== undefined) change = { ...change, size } as typeof change;
      if (Object.keys(change).length > 0) await call('setattr', { path: rel(path), ...change });
    },
    statfs: () => call<DriverStatfs>('statfs'),
  };
  return handlers;
}

const KEEP: OpenFlags = { write: false, create: false, truncate: false, exclusive: false };

async function resize(h: FilesystemHandlers, path: string, size: number): Promise<void> {
  const was = (await h.getattr(path)).size;
  if (size === was) return;
  const kept: Uint8Array[] = [];
  if (size < was && size > 0) {
    const fh = await h.open(path, KEEP);
    try {
      for (let at = 0; at < size; ) {
        const bytes = await h.read(fh, at, size - at);
        if (bytes.length === 0) break;
        kept.push(bytes);
        at += bytes.length;
      }
    } finally {
      await h.release(fh);
    }
  }
  const fh = await h.open(path, { ...KEEP, write: true, truncate: size < was });
  try {
    if (size > was) await h.write(fh, size - 1, new Uint8Array(1));
    let at = 0;
    for (const bytes of kept) {
      await h.write(fh, at, bytes);
      at += bytes.length;
    }
  } finally {
    await h.release(fh);
  }
}

export interface WatchLoop {
  connect(): Promise<HostfsTransport>;
  up(client: HostfsTransport): void;
  event(event: HostfsEvent): void;
  down(): void;
  silenceMs?: number;
  backoffMs?: [number, number];
  connectMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

export interface Watching {
  ready: Promise<void>;
  kick(): void;
}

export function keepWatching(loop: WatchLoop, signal: AbortSignal): Watching {
  const silenceMs = loop.silenceMs ?? 45_000;
  const [first, most] = loop.backoffMs ?? [1000, 30_000];
  const ready = Promise.withResolvers<void>();
  const capped = setTimeout(ready.resolve, loop.connectMs ?? 15_000);
  const uncap = () => clearTimeout(capped);
  void ready.promise.then(uncap);
  signal.addEventListener('abort', uncap, { once: true });
  let wait = first;
  let up = false;
  let current: AbortController | undefined;
  async function session(): Promise<boolean> {
    const session = new AbortController();
    current = session;
    const stop = () => session.abort();
    signal.addEventListener('abort', stop);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => {
      clearTimeout(timer);
      timer = setTimeout(stop, silenceMs);
    };
    let opened = false;
    try {
      const client = await loop.connect();
      quiet();
      await client.watch(
        session.signal,
        (event) => {
          quiet();
          if (!event.ping) loop.event(event);
        },
        () => {
          quiet();
          opened = true;
          up = true;
          loop.up(client);
          ready.resolve();
        }
      );
      return opened;
    } catch {
      return opened;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }
  void (async () => {
    while (!signal.aborted) {
      const began = Date.now();
      const opened = await session();
      if (signal.aborted) return;
      if (opened && Date.now() - began >= first) {
        wait = first;
        continue;
      }
      if (!opened && up) {
        up = false;
        loop.down();
      }
      ready.resolve();
      await sleep(wait, signal);
      wait = Math.min(wait * 2, most);
    }
  })();
  return { ready: ready.promise, kick: () => current?.abort() };
}

export function invalidation(event: HostfsEvent): string[] | true {
  return event.paths ?? true;
}

export interface HostfsTiming {
  silenceMs?: number;
  backoffMs?: [number, number];
  connectMs?: number;
}

let nextPortToken = 0;

type PortReply = {
  id: number;
  result?: unknown;
  bytes?: Uint8Array;
  event?: HostfsEvent;
  open?: boolean;
  end?: boolean;
  error?: { code?: string; message?: string };
};

export class PortTransport implements HostfsTransport {
  readonly capabilities: DriverCapabilities;
  readonly token: string;
  private readonly port: MessagePort;
  private readonly waiting = new Map<number, (reply: PortReply) => void>();
  private next = 0;

  constructor(grant: HostfsPortGrant) {
    this.port = grant.port;
    this.capabilities = grant.capabilities ?? {};
    this.token = grant.token ?? `port-${++nextPortToken}`;
    this.port.addEventListener('message', (event: MessageEvent<PortReply>) => {
      this.waiting.get(event.data?.id)?.(event.data);
    });
    this.port.start();
  }

  get maxIo(): number {
    return this.capabilities.maxIo ?? HOSTFS_IO;
  }

  private ask(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<PortReply> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (reply) => {
        this.waiting.delete(id);
        if (reply.error) reject(fsError(reply.error.code ?? 'EIO', reply.error.message ?? ''));
        else resolve(reply);
      });
      try {
        this.port.postMessage({ id, ...message }, transfer);
      } catch (err) {
        this.waiting.delete(id);
        reject(fsError('ENOTCONN', `the folder's port is closed: ${(err as Error).message}`));
      }
    });
  }

  async call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    return (await this.ask({ op: 'call', name: op, body })).result as T;
  }

  async read(fh: number, offset: number, size: number, ifMatch?: string): Promise<Uint8Array> {
    const reply = await this.ask({ op: 'read', fh, offset, size, ...(ifMatch ? { ifMatch } : {}) });
    return reply.bytes ?? new Uint8Array(0);
  }

  async write(fh: number, offset: number, bytes: Uint8Array): Promise<void> {
    await this.ask({ op: 'write', fh, offset, bytes });
  }

  watch(
    signal: AbortSignal,
    onEvent: (event: HostfsEvent) => void,
    onOpen: () => void = () => undefined
  ): Promise<void> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.waiting.delete(id);
        signal.removeEventListener('abort', stop);
      };
      const stop = () => {
        finish();
        this.port.postMessage({ id, op: 'unwatch' });
        resolve();
      };
      this.waiting.set(id, (reply) => {
        if (reply.open) return onOpen();
        if (reply.event) return onEvent(reply.event);
        finish();
        if (reply.error) reject(fsError(reply.error.code ?? 'ENOTCONN', reply.error.message ?? ''));
        else resolve();
      });
      signal.addEventListener('abort', stop, { once: true });
      this.port.postMessage({ id, op: 'watch' });
    });
  }
}

const errorOf = (err: unknown) => ({
  code: typeof codeOf(err) === 'string' ? (codeOf(err) as string) : 'EIO',
  message: (err as Error | null)?.message ?? String(err),
});

export function serveHostfsPort(port: MessagePort, transport: HostfsTransport): () => void {
  const watches = new Map<number, AbortController>();
  const send = (reply: PortReply, transfer: Transferable[] = []) =>
    port.postMessage(reply, transfer);
  const listener = async ({
    data,
  }: MessageEvent<Record<string, unknown> & { id: number; op: string }>) => {
    const { id, op } = data;
    if (op === 'unwatch') return watches.get(id)?.abort();
    if (op === 'watch') {
      const stop = new AbortController();
      watches.set(id, stop);
      try {
        await transport.watch(
          stop.signal,
          (event) => send({ id, event }),
          () => send({ id, open: true })
        );
        send({ id, end: true });
      } catch (err) {
        send({ id, error: errorOf(err) });
      } finally {
        watches.delete(id);
      }
      return;
    }
    try {
      if (op === 'read') {
        const bytes = await transport.read(
          data.fh as number,
          data.offset as number,
          data.size as number,
          data.ifMatch as string | undefined
        );
        return send({ id, bytes }, [bytes.buffer as ArrayBuffer]);
      }
      if (op === 'write') {
        await transport.write(data.fh as number, data.offset as number, data.bytes as Uint8Array);
        return send({ id });
      }
      if (op !== 'call') throw fsError('EINVAL', `unknown hostfs port op ${op}`);
      send({
        id,
        result: await transport.call(data.name as string, data.body as Record<string, unknown>),
      });
    } catch (err) {
      send({ id, error: errorOf(err) });
    }
  };
  port.addEventListener('message', listener as (event: MessageEvent) => void);
  port.start();
  return () => {
    port.removeEventListener('message', listener as (event: MessageEvent) => void);
    for (const stop of watches.values()) stop.abort();
    port.close();
  };
}

export function grantConnect(hook: HostfsGrantHook, fetch: FetchLike): HostfsConnect {
  return async (source, options) => {
    const first = await hook(source, options);
    if ('port' in first) return new PortTransport(first);
    const grant = async () => {
      const again = await hook(source, options);
      if ('port' in again)
        throw fsError('ESTALE', 'the folder moved to a port, so its open files are gone');
      return again;
    };
    return new HostfsClient(first, grant, fetch);
  };
}

export async function openHostfs(
  spec: MountSpec,
  connect: HostfsConnect,
  timing: HostfsTiming = {}
): Promise<OpenedDriver> {
  const readonly = spec.options?.ro !== undefined;
  const { port1, port2 } = new MessageChannel();
  const slot = mediumSlot<HostfsTransport>(
    async (err) => unreachable(err),
    () => watching.kick()
  );
  const stop = new AbortController();
  let active: HostfsTransport | undefined;
  const handlers = hostfsHandlers(() => active as HostfsTransport);
  const ranged = () => (active?.capabilities.ranges === true ? { ranges: true } : {});
  const served = serveFilesystem(
    port2,
    { ...slot.handlers, mount: ranged },
    {
      symlinks: true,
      chmod: true,
      listingStats: true,
      maxIo: HOSTFS_IO,
      ...(readonly ? { readonly: true } : {}),
    }
  );
  const watching = keepWatching(
    {
      connect: () => connect(spec.source, { readonly }),
      up(client) {
        active = client;
        slot.insert(client, handlers);
        served.invalidate(true);
      },
      event: (event) => served.invalidate(invalidation(event)),
      down() {
        slot.eject();
        served.invalidate(true);
      },
      ...timing,
    },
    stop.signal
  );
  await watching.ready;
  return {
    port: port1,
    present: slot.present,
    dispose() {
      stop.abort();
      port1.close();
      port2.close();
    },
  };
}
