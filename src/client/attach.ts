import type { FsStat } from '../fs/types.ts';
import type { WatchChange } from '../fs/watch.ts';
import { RemoteTransport, type TransportReply } from '../kernel/net/remote-transport.ts';
import type {
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
} from '../kernel/net/transport.ts';
import type { MountEntry, MountSpec } from '../mount/mount-fs.ts';
import {
  type ClientCall,
  type ClientReply,
  type FsMethod,
  type KernelHello,
  type LockManagerLike,
  locksOf,
  type MessagePortLike,
  PROTOCOL,
  type ProcessEntry,
  type TerminalAction,
  versionError,
} from './protocol.ts';

export type { WatchChange } from '../fs/watch.ts';
export type { ProcessEntry } from './protocol.ts';

export class KernelGoneError extends Error {
  constructor(message = 'the slicc-kernel this client was attached to is gone') {
    super(message);
    this.name = 'KernelGoneError';
  }
}

export class KernelCallError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'KernelCallError';
    this.code = code;
  }
}

export interface AttachOptions {
  timeoutMs?: number;
  locks?: LockManagerLike | null;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  group?: 'new';
  pgid?: number;
  onStdout?: (bytes: Uint8Array) => void;
  onStderr?: (bytes: Uint8Array) => void;
}

export interface SpawnedProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly exited: Promise<number>;
  signal(name?: string): Promise<void>;
}

export interface ClientRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface ClientRunResult {
  pid: number;
  status: number;
  stdout: string;
  stderr: string;
}

export interface ClientTerminalOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  onData?: (bytes: Uint8Array) => void;
}

export interface ClientTerminal {
  readonly pid: number;
  readonly exited: Promise<number>;
  onData: ((bytes: Uint8Array) => void) | null;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  signal(name: string): void;
  close(): void;
}

export interface ClientFs {
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FsStat>;
  lstat(path: string): Promise<FsStat>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  watch(
    paths: string[],
    options: { recursive?: boolean },
    onChange: (change: WatchChange) => void
  ): Promise<{ close(): void }>;
}

export type ClientFetchRequest = Omit<RealmTransportRequest, 'signal'> & { signal?: AbortSignal };

export interface KernelClient {
  readonly protocol: readonly [number, number];
  readonly transport: RealmTransport;
  readonly closed: Promise<Error>;
  spawn(argv: string[], options?: SpawnOptions): Promise<SpawnedProcess>;
  run(argv: string[], options?: ClientRunOptions): Promise<ClientRunResult>;
  openTerminal(argv: string[], options?: ClientTerminalOptions): Promise<ClientTerminal>;
  ps(): Promise<ProcessEntry[]>;
  mount(spec: MountSpec): Promise<MountEntry>;
  umount(target: string): Promise<void>;
  mounts(): Promise<MountEntry[]>;
  kill(pid: number, signal?: string): Promise<void>;
  fetch(request: ClientFetchRequest): Promise<RealmTransportResponse>;
  readonly fs: ClientFs;
  close(options?: { kill?: boolean }): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  output?: (fd: 1 | 2, bytes: Uint8Array) => void;
  started?: (pid: number) => void;
}

type Handlers = Omit<Pending, 'resolve' | 'reject'>;

const encoder = new TextEncoder();
const bytesOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? encoder.encode(data) : data;

const UNAVAILABLE = {
  manualRedirects: false,
  encodedBodies: false,
  maxRequestBody: 0,
  unavailable: true,
} as const;

async function holdLock(
  locks: LockManagerLike | undefined
): Promise<{ name?: string; release(): void }> {
  if (!locks) return { release() {} };
  const name = `slicc-kernel-client:${crypto.randomUUID()}`;
  const granted = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  void locks.request(name, () => {
    granted.resolve();
    return held.promise;
  });
  await granted.promise;
  return { name, release: () => held.resolve() };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

class Channel {
  readonly greeted = Promise.withResolvers<KernelHello>();
  readonly ended = Promise.withResolvers<Error>();
  remote: RemoteTransport | undefined;
  failure: Error | undefined;
  private readonly pending = new Map<number, Pending>();
  readonly watching = new Map<number, (change: WatchChange) => void>();
  protocol: readonly [number, number] = PROTOCOL;
  private nextId = 0;
  private readonly port: MessagePortLike;
  private readonly release: () => void;

  constructor(port: MessagePortLike, release: () => void) {
    this.port = port;
    this.release = release;
    this.greeted.promise.catch(() => undefined);
    port.addEventListener('message', (event) => this.receive(event.data));
    port.addEventListener('close', () => this.end(new KernelGoneError()));
    port.start?.();
  }

  post(message: object): void {
    if (!this.failure) this.port.postMessage(message);
  }

  end(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.greeted.reject(error);
    this.remote?.fail(error);
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
    this.release();
    this.port.close?.();
    this.ended.resolve(error);
  }

  request(call: ClientCall, handlers: Handlers = {}): { id: number; done: Promise<unknown> } {
    const id = ++this.nextId;
    const { failure } = this;
    if (failure) return { id, done: Promise.reject(failure) };
    const done = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...handlers });
      this.port.postMessage({ ...call, id });
    });
    return { id, done };
  }

  call(call: ClientCall): Promise<unknown> {
    return this.request(call).done;
  }

  private receive(data: {
    hello?: KernelHello;
    net?: unknown;
    bye?: string;
    watch?: number;
    change?: WatchChange;
  }): void {
    if (data.watch !== undefined) {
      this.watching.get(data.watch)?.(data.change as WatchChange);
      return;
    }
    if (data.bye !== undefined) {
      this.end(new KernelGoneError(data.bye));
      return;
    }
    if (data.hello) {
      this.greeted.resolve(data.hello);
      return;
    }
    if (data.net !== undefined) {
      this.remote?.receive(data as TransportReply);
      return;
    }
    const reply = data as ClientReply;
    const call = this.pending.get(reply.id);
    if (!call) return;
    if (reply.fd !== undefined) {
      call.output?.(reply.fd, reply.bytes as Uint8Array);
      return;
    }
    if (reply.started !== undefined) {
      call.started?.(reply.started);
      return;
    }
    this.pending.delete(reply.id);
    if (reply.error !== undefined) call.reject(new KernelCallError(reply.error, reply.code));
    else call.resolve(reply.result);
  }
}

async function spawnOn(
  channel: Channel,
  argv: string[],
  opts: SpawnOptions
): Promise<SpawnedProcess> {
  const { onStdout, onStderr, stdin, group: _, ...rest } = opts;
  if (opts.pgid !== undefined)
    await since(channel, 3, 'spawn into a process group', async () => {});
  const started = Promise.withResolvers<number>();
  const options = { ...rest, ...(stdin !== undefined ? { stdin: bytesOf(stdin) } : {}) };
  const { done } = channel.request(
    { op: 'spawn', argv, options },
    {
      output: (fd, bytes) => (fd === 1 ? onStdout : onStderr)?.(bytes),
      started: started.resolve,
    }
  );
  done.catch(started.reject);
  const pid = await started.promise;
  const pgid = opts.pgid ?? pid;
  return {
    pid,
    pgid,
    exited: done as Promise<number>,
    signal: async (name = 'SIGTERM') =>
      void (await channel.call({ op: 'kill', pid: -pgid, signal: name })),
  };
}

async function runOn(
  channel: Channel,
  argv: string[],
  opts: ClientRunOptions
): Promise<ClientRunResult> {
  const { onStdout, onStderr, ...rest } = opts;
  const chunks: Record<1 | 2, Uint8Array[]> = { 1: [], 2: [] };
  const live = { 1: new TextDecoder(), 2: new TextDecoder() };
  const tee = (fd: 1 | 2, on?: (text: string) => void) => (bytes: Uint8Array) => {
    chunks[fd].push(bytes);
    on?.(live[fd].decode(bytes, { stream: true }));
  };
  const child = await spawnOn(channel, argv, {
    ...rest,
    onStdout: tee(1, onStdout),
    onStderr: tee(2, onStderr),
  });
  const status = await child.exited;
  const text = (fd: 1 | 2) => new TextDecoder().decode(concat(chunks[fd]));
  return { pid: child.pid, status, stdout: text(1), stderr: text(2) };
}

async function terminalOn(
  channel: Channel,
  argv: string[],
  opts: ClientTerminalOptions
): Promise<ClientTerminal> {
  const { onData, ...options } = opts;
  let listener = onData ?? null;
  const backlog: Uint8Array[] = [];
  const started = Promise.withResolvers<number>();
  const { id, done } = channel.request(
    { op: 'open-terminal', argv, options },
    {
      output: (_fd, bytes) => (listener ? listener(bytes) : backlog.push(bytes)),
      started: started.resolve,
    }
  );
  done.catch(started.reject);
  const pid = await started.promise;
  const send = (action: TerminalAction) =>
    void channel.call({ op: 'terminal', terminal: id, ...action }).catch(() => undefined);
  return {
    pid,
    exited: done as Promise<number>,
    get onData() {
      return listener;
    },
    set onData(next) {
      listener = next;
      if (next) for (const bytes of backlog.splice(0)) next(bytes);
    },
    write: (data) => send({ action: 'write', bytes: bytesOf(data) }),
    resize: (cols, rows) => send({ action: 'resize', cols, rows }),
    signal: (name) => send({ action: 'signal', signal: name }),
    close: () => send({ action: 'close' }),
  };
}

function fsOn(channel: Channel): ClientFs {
  const fs = (method: FsMethod, ...args: unknown[]) => channel.call({ op: 'fs', method, args });
  const done = async (method: FsMethod, ...args: unknown[]) => void (await fs(method, ...args));
  return {
    readFile: (path) => fs('readFile', path) as Promise<Uint8Array>,
    readText: async (path) => new TextDecoder().decode((await fs('readFile', path)) as Uint8Array),
    writeFile: (path, data) => done('writeFile', path, data),
    stat: (path) => fs('stat', path) as Promise<FsStat>,
    lstat: (path) => fs('lstat', path) as Promise<FsStat>,
    readdir: (path) => fs('readdir', path) as Promise<string[]>,
    mkdir: (path) => done('mkdir', path),
    rm: (path, o = {}) => done('rm', path, o.force === true),
    rename: (from, to) => done('rename', from, to),
    realpath: (path) => fs('realpath', path) as Promise<string>,
    symlink: (target, path) => done('symlink', target, path),
    readlink: (path) => fs('readlink', path) as Promise<string>,
    exists: (path) => fs('exists', path) as Promise<boolean>,
    async watch(paths, options, onChange) {
      if (channel.protocol[1] < 1) {
        throw new KernelCallError(
          `this kernel speaks protocol ${channel.protocol.join('.')}, which has no watch`,
          'ENOSYS'
        );
      }
      const { id, done } = channel.request({
        op: 'watch',
        paths,
        recursive: options.recursive === true,
      });
      channel.watching.set(id, onChange);
      try {
        await done;
      } catch (error) {
        channel.watching.delete(id);
        throw error;
      }
      return {
        close: () => {
          if (!channel.watching.delete(id)) return;
          void channel.call({ op: 'unwatch', watch: id }).catch(() => undefined);
        },
      };
    },
  };
}

function since(channel: Channel, minor: number, what: string, run: () => Promise<unknown>) {
  if (channel.protocol[1] < minor) {
    return Promise.reject(
      new KernelCallError(
        `this kernel speaks protocol ${channel.protocol.join('.')}, which has no ${what}`,
        'ENOSYS'
      )
    );
  }
  return run();
}

async function greet(
  channel: Channel,
  lock: string | undefined,
  timeoutMs: number
): Promise<KernelHello> {
  channel.post({ hello: { protocol: PROTOCOL, ...(lock ? { lock } : {}) } });
  const timer = setTimeout(
    () =>
      channel.end(
        new KernelGoneError(`no slicc-kernel answered on this port within ${timeoutMs} ms`)
      ),
    timeoutMs
  );
  let hello: KernelHello;
  try {
    hello = await channel.greeted.promise;
  } finally {
    clearTimeout(timer);
  }
  const refused = hello.error ?? versionError(hello.protocol);
  if (refused) {
    const error = new Error(refused);
    channel.end(error);
    throw error;
  }
  return hello;
}

export async function attachKernel(
  port: MessagePortLike,
  options: AttachOptions = {}
): Promise<KernelClient> {
  const locks = options.locks === null ? undefined : (options.locks ?? locksOf());
  const own = await holdLock(locks);
  const channel = new Channel(port, own.release);
  const hello = await greet(channel, own.name, options.timeoutMs ?? 10_000);
  channel.protocol = hello.protocol;
  if (hello.lock && locks) void locks.request(hello.lock, () => channel.end(new KernelGoneError()));
  const transport = new RemoteTransport(
    { postMessage: (call) => channel.post(call) },
    hello.traits ?? UNAVAILABLE
  );
  channel.remote = transport;
  return {
    protocol: hello.protocol,
    transport,
    closed: channel.ended.promise,
    spawn: (argv, opts = {}) => spawnOn(channel, argv, opts),
    run: (argv, opts = {}) => runOn(channel, argv, opts),
    openTerminal: (argv, opts = {}) => terminalOn(channel, argv, opts),
    ps: () => channel.call({ op: 'ps' }) as Promise<ProcessEntry[]>,
    mount: (spec) =>
      since(channel, 2, 'mount', () => channel.call({ op: 'mount', spec })) as Promise<MountEntry>,
    umount: async (target) =>
      void (await since(channel, 2, 'umount', () => channel.call({ op: 'umount', target }))),
    mounts: () =>
      since(channel, 2, 'mounts', () => channel.call({ op: 'mounts' })) as Promise<MountEntry[]>,
    kill: async (pid, signal = 'SIGTERM') => void (await channel.call({ op: 'kill', pid, signal })),
    fetch: (req) => {
      const { signal, ...rest } = req;
      return transport.fetch({ ...rest, signal: signal ?? new AbortController().signal });
    },
    fs: fsOn(channel),
    async close(o = {}) {
      if (channel.failure) return;
      await channel
        .call({ op: 'detach', ...(o.kill ? { kill: true } : {}) })
        .catch(() => undefined);
      channel.end(new KernelGoneError('this client is closed'));
    },
  };
}
