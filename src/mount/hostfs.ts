import { fsError, type OpenFlags, serveFilesystem } from './driver.ts';
import { type MediumHandlers, mediumSlot } from './medium.ts';
import type { MountSpec, OpenedDriver } from './mount-fs.ts';
import type { DriverAttr, DriverCapabilities, DriverEntry, DriverStatfs } from './protocol.ts';

export interface HostfsGrant {
  url: string;
  token: string;
  readonly?: boolean;
  capabilities?: DriverCapabilities;
}

export type HostfsGrantHook = (
  source: string,
  options: { readonly: boolean }
) => Promise<HostfsGrant>;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HostfsEvent {
  paths?: string[];
  all?: boolean;
  ping?: number;
}

export const HOSTFS_IO = 16 * 1024 * 1024;

const codeOf = (err: unknown) => (err as { code?: unknown } | null)?.code;

export const unreachable = (err: unknown) => codeOf(err) === 'ENOTCONN';

function rel(path: string): string {
  return path.replace(/^\/+/, '');
}

export class HostfsClient {
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
  client: HostfsClient;
  token: string;
  fh: number;
  etag: string | undefined;
  restore: { path: string; mode: number } | undefined;
}

export function hostfsHandlers(current: () => HostfsClient): MediumHandlers {
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
  async function writable(client: HostfsClient, path: string, flags: OpenFlags) {
    const opening = () =>
      client.call<{ fh: number; attr?: DriverAttr }>('open', { path: rel(path), ...flags });
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
  return {
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
    setattr: async (path, change) => void (await call('setattr', { path: rel(path), ...change })),
    statfs: () => call<DriverStatfs>('statfs'),
  };
}

export interface WatchLoop {
  connect(): Promise<HostfsClient>;
  up(client: HostfsClient): void;
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

export async function openHostfs(
  spec: MountSpec,
  hook: HostfsGrantHook,
  fetch: FetchLike,
  timing: HostfsTiming = {}
): Promise<OpenedDriver> {
  const readonly = spec.options?.ro !== undefined;
  const { port1, port2 } = new MessageChannel();
  const slot = mediumSlot<HostfsClient>(
    async (err) => unreachable(err),
    () => watching.kick()
  );
  const stop = new AbortController();
  const grant = () => hook(spec.source, { readonly });
  let active: HostfsClient | undefined;
  const handlers = hostfsHandlers(() => active as HostfsClient);
  const served = serveFilesystem(port2, slot.handlers, {
    symlinks: true,
    chmod: true,
    listingStats: true,
    maxIo: HOSTFS_IO,
    ...(readonly ? { readonly: true } : {}),
  });
  const watching = keepWatching(
    {
      connect: async () => new HostfsClient(await grant(), grant, fetch),
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
