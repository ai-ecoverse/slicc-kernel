import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MessageChannel, type MessagePort, type Worker } from 'node:worker_threads';
import type { CdpHook } from './cdp/types.ts';
import type { MessagePortLike } from './client/protocol.ts';
import { type ServedClient, serveClient } from './client/serve-client.ts';
import type { CronClock } from './cron/clock.ts';
import type { FacadeSpecs } from './facade/types.ts';
import type { Attestation, AttestTombstone } from './fs/attest.ts';
import type { DenialHook } from './fs/dac.ts';
import { OpfsFs } from './fs/opfs.ts';
import type { Protection } from './fs/protect.ts';
import { DEFAULT_USERS, fsError, modeOption, type UsersMode } from './fs/types.ts';
import { pidOwner } from './fs/unlinked.ts';
import type {
  ConnectOptions,
  KernelGroups,
  KernelIntegrity,
  KernelSealed,
  KernelUsers,
  RunOptions,
  RunResult,
  Terminal,
  TerminalOptions,
} from './index.ts';
import type { ClipboardHook } from './kernel/clipboard.ts';
import { type EmbedderHook, kindsOf } from './kernel/embedder.ts';
import type { WasmWorkerLike } from './kernel/host.ts';
import type { RouteTable } from './kernel/net/routes.ts';
import { type SealedOption, sealedHooks } from './kernel/net/sealed-fetch.ts';
import type { NetworkUplink } from './kernel/net/uplink.ts';
import { quiet, signalField } from './kernel/signals.ts';
import { Launcher, tagOption } from './launcher.ts';
import type { FetchLike, HostfsGrantHook } from './mount/hostfs.ts';
import type { MountEntry, MountSpec } from './mount/mount-fs.ts';
import type { ProcessMountPolicy } from './mount/syscall.ts';
import { guardedLoopback, type HostLoopback } from './node/loopback.ts';
import { isMemoryRoot, memoryRoot } from './node/memory-root.ts';
import { bootWorker } from './node/worker-boot.ts';
import { diagnosing } from './node/ws-diagnose.ts';
import { signalNumber } from './serve.ts';
import type { ApproveHook } from './sudo.ts';
import { fetchTransport, type NetworkTransport } from './transport.ts';

export type { CdpConnection, CdpHook, CdpRequest } from './cdp/types.ts';
export {
  type AttachOptions,
  attachKernel,
  type ClientEnded,
  type ClientFetchRequest,
  type ClientFs,
  type ClientRunOptions,
  type ClientRunResult,
  type ClientTerminal,
  type ClientTerminalOptions,
  KernelCallError,
  type KernelClient,
  KernelGoneError,
  type ProcessEntry,
  type SpawnedProcess,
  type SpawnOptions,
  type WatchChange,
} from './client/attach.ts';
export type {
  FacadeConnection,
  FacadeHook,
  FacadeInfo,
  FacadeSpec,
  FacadeSpecs,
} from './facade/types.ts';
export type { Attestation, AttestedDir, AttestOptions, AttestTombstone } from './fs/attest.ts';
export type { Denial, DenialHook } from './fs/dac.ts';
export type {
  ConnectOptions,
  Ended,
  KernelGroups,
  KernelIntegrity,
  KernelSealed,
  KernelUsers,
  NetworkUplink,
  ResolveAnswer,
  ResolveFamily,
  RouteTable,
  RunOptions,
  RunResult,
  Terminal,
  TerminalOptions,
  TerminalSignal,
} from './index.ts';
export type { ClipboardHook, ClipboardStamp } from './kernel/clipboard.ts';
export type {
  EmbedderHook,
  EmbedderKindPolicy,
  EmbedderReply,
  EmbedderRequest,
  EmbedderStamp,
} from './kernel/embedder.ts';
export {
  SEALED_FETCH_VERSION,
  type SealedFetchHook,
  type SealedFetchRequest,
  type SealedOption,
} from './kernel/net/sealed-fetch.ts';
export type {
  SealedAbortReason,
  SealedCaller,
  SealedHook,
  SealedRequest,
} from './kernel/sealed.ts';
export type { ConnectorStamp } from './kernel/socket.ts';
export type {
  HostfsEvent,
  HostfsGrant,
  HostfsGrantHook,
  HostfsPortGrant,
  HostfsTransport,
} from './mount/hostfs.ts';
export { serveHostfsPort } from './mount/hostfs.ts';
export type { MountEntry, MountSpec } from './mount/mount-fs.ts';
export type { ApproveHook, SudoAnswer, SudoRequest } from './sudo.ts';
export type { NetworkRedirectPolicy } from './transport.ts';
export { fetchTransport, type NetworkTransport } from './transport.ts';
export { memoryRoot };

export interface NodeKernelOptions {
  root?: FileSystemDirectoryHandle;
  modules?: string;
  commands?: { append?: readonly string[] };
  env?: Record<string, string>;
  network?: { transport?: NetworkTransport; uplink?: NetworkUplink; doh?: string | false };
  worker?: string | URL;
  driverWorker?: string | URL;
  processMounts?: ProcessMountPolicy;
  fstabRetries?: readonly number[];
  hostfs?: HostfsGrantHook;
  hostfsFetch?: FetchLike;
  hostfsOrigin?: string;
  cdp?: CdpHook;
  facades?: FacadeSpecs;
  hostname?: string;
  users?: UsersMode;
  onDenial?: DenialHook;
  sealed?: SealedOption;
  clipboard?: ClipboardHook;
  requests?: EmbedderHook;
  approve?: ApproveHook;
  protect?: Protection;
  cron?: { clock?: CronClock };
  compileCache?: string | false;
  warmWorker?: boolean;
  warmWorkers?: number;
  wasmMemories?: { ceiling?: number; idleMs?: number };
}

export interface NodeKernel {
  readonly root: FileSystemDirectoryHandle;
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  openTerminal(argv: string[], options?: TerminalOptions): Promise<Terminal>;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  chmod(path: string, mode: number): Promise<void>;
  readonly integrity: KernelIntegrity;
  readonly sealed: KernelSealed;
  attest(path: string): Promise<Attestation>;
  attest(path: string, options: { absent: 'allow' }): Promise<Attestation | AttestTombstone>;
  connect(options?: ConnectOptions): Promise<MessagePort>;
  readonly users: KernelUsers;
  readonly groups: KernelGroups;
  setRoutes(routes: RouteTable): Promise<void>;
  updateTransportTraits(): Promise<boolean>;
  mount(spec: MountSpec): Promise<MountEntry>;
  umount(target: string): Promise<void>;
  mounts(): Promise<MountEntry[]>;
  terminate(): void;
}

function hostfsFetchOf(options: NodeKernelOptions): { hostfsFetch?: FetchLike } {
  const { hostfsFetch, hostfsOrigin } = options;
  if (hostfsOrigin === undefined) return hostfsFetch ? { hostfsFetch } : {};
  const base: FetchLike = hostfsFetch ?? ((url, init) => fetch(url, init));
  return {
    hostfsFetch: (url, init) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', hostfsOrigin);
      return base(url, { ...init, headers });
    },
  };
}

export interface NodeTransportOptions {
  hostLoopback?: HostLoopback;
}

export function nodeTransport(options: NodeTransportOptions = {}): NetworkTransport {
  const transport = fetchTransport({
    webSocket: true,
    webSocketHeaders: true,
    redirect: 'manual',
    streamingBodies: true,
  });
  const open = { ...transport, traits: { ...transport.traits, crossOrigin: 'any' as const } };
  return diagnosing(guardedLoopback(open, options.hostLoopback ?? false));
}

const TERMINATED = 'the kernel is terminated';
const EXIT_GRACE_MS = 50;

export const WARM_IDLE_MS = 30_000;
export const MAX_WARM_WORKERS = 64;

type MakeWorker = () => Worker;

export function warmPool(make: MakeWorker, live: Set<() => void>, idleMs = WARM_IDLE_MS, size = 1) {
  const spares: Worker[] = [];
  let idle: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const drop = (worker: Worker) => {
    const at = spares.indexOf(worker);
    if (at < 0) return;
    spares.splice(at, 1);
    if (spares.length > 0) return;
    clearTimeout(idle);
    live.delete(kill);
  };
  const kill = () => {
    for (const worker of [...spares]) {
      drop(worker);
      void worker.terminate();
    }
  };
  const fill = () => {
    while (!closed && spares.length < size) {
      let worker: Worker;
      try {
        worker = make();
      } catch {
        closed = true;
        return;
      }
      worker.unref();
      worker.once('error', () => drop(worker));
      worker.once('exit', () => drop(worker));
      spares.push(worker);
      live.add(kill);
    }
    clearTimeout(idle);
    idle = setTimeout(kill, idleMs);
    idle.unref?.();
  };
  return {
    take(): Worker {
      const worker = spares[0];
      if (worker) {
        drop(worker);
        worker.removeAllListeners('error');
        worker.removeAllListeners('exit');
        worker.ref();
      }
      setImmediate(fill);
      return worker ?? make();
    },
    close() {
      closed = true;
      kill();
    },
  };
}

export function sparesOf(options: { warmWorker?: boolean; warmWorkers?: unknown }): number {
  if (options.warmWorker === false) return 0;
  const n = options.warmWorkers ?? 1;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_WARM_WORKERS) {
    throw new TypeError(
      `createNodeKernel: warmWorkers must be an integer from 0 to ${MAX_WARM_WORKERS}`
    );
  }
  return n;
}

const INTERNALS = '--expose-internals';
let internalArgv: string[] | null | undefined;

export function narrowArgv(argv: readonly string[], message: string): string[] | null {
  const at = message.indexOf(': ');
  if (at < 0) return null;
  const bad = new Set(message.slice(at + 2).split(', '));
  const kept = argv.filter((arg) => !bad.has(arg));
  return kept.length < argv.length ? kept : null;
}

export function internalsWorker(
  make: (execArgv?: string[]) => Worker,
  argv: readonly string[] = process.execArgv
): Worker {
  internalArgv ??= [...argv, INTERNALS];
  for (let tries = 0; internalArgv !== null && tries < 2; tries++) {
    try {
      return make(internalArgv);
    } catch (err) {
      const { code, message } = err as { code?: unknown; message?: unknown };
      if (code !== 'ERR_WORKER_INVALID_EXEC_ARGV' || typeof message !== 'string') throw err;
      internalArgv = narrowArgv(internalArgv, message);
    }
  }
  internalArgv = null;
  return make();
}

export function resetInternalArgv(): void {
  internalArgv = undefined;
}

function processWorker(
  file: string | URL,
  workerData?: { compileCache: string; ownedCache?: boolean },
  internals = false
): Worker {
  const make = (execArgv?: string[]) =>
    bootWorker(
      file,
      { env: workerEnv(), ...(workerData ? { workerData } : {}), execArgv },
      new URL('./node-process-worker.cjs', import.meta.url)
    );
  return internals ? internalsWorker(make) : make();
}

export function sourceModule(source: string): { url: string; source: string; revoke(): void } {
  const url = `slicc-module:${createHash('sha256').update(source).digest('hex')}`;
  return { url, source, revoke: () => {} };
}

function warmPoolOf(
  options: NodeKernelOptions,
  file: string | URL,
  workerData: { compileCache: string; ownedCache?: boolean } | undefined,
  live: Set<() => void>
) {
  const size = sparesOf(options);
  if (size === 0) return undefined;
  return warmPool(() => processWorker(file, workerData, true), live, WARM_IDLE_MS, size);
}

function nodeWorker(
  file: string | URL,
  live: Set<() => void>,
  closed: boolean,
  workerData?: { compileCache: string; ownedCache?: boolean },
  take?: () => Worker,
  internals = false
): WasmWorkerLike {
  const errors = new Set<(event: MessageEvent) => void>();
  const messages = new Map<(event: MessageEvent) => void, (data: unknown) => void>();
  const fail = (message: string) => {
    for (const handler of [...errors]) {
      handler({ message, preventDefault() {} } as unknown as MessageEvent);
    }
  };
  const worker = closed ? undefined : (take?.() ?? processWorker(file, workerData, internals));
  let ending = false;
  if (worker) {
    const kill = () => {
      ending = true;
      void worker.terminate();
      fail(TERMINATED);
    };
    live.add(kill);
    worker.once('exit', (code) => {
      live.delete(kill);
      setTimeout(() => {
        if (!ending) fail(`the process worker exited with ${code}`);
      }, EXIT_GRACE_MS);
    });
    worker.on('error', (err) => fail(String(err)));
  } else {
    setTimeout(() => fail(TERMINATED), 0);
  }
  return {
    postMessage: (message, transfer) => worker?.postMessage(message, transfer as never),
    addEventListener(type, handler) {
      if (type === 'error') {
        errors.add(handler);
        return;
      }
      const listener = (data: unknown) => handler({ data } as MessageEvent);
      messages.set(handler, listener);
      worker?.on('message', listener);
    },
    removeEventListener(type, handler) {
      errors.delete(handler);
      const listener = messages.get(handler);
      if (listener) worker?.off('message', listener);
    },
    terminate: () => {
      ending = true;
      void worker?.terminate();
    },
  };
}

function textOf(on: ((text: string) => void) | undefined) {
  if (!on) return undefined;
  const decoder = new TextDecoder();
  return (bytes: Uint8Array) => on(decoder.decode(bytes, { stream: true }));
}

const cronLocks = new WeakMap<FileSystemDirectoryHandle, string>();

function cronLock(root: FileSystemDirectoryHandle): string {
  let lock = cronLocks.get(root);
  if (!lock) cronLocks.set(root, (lock = `slicc-kernel-cron:${crypto.randomUUID()}`));
  return lock;
}

function workerEnv(): NodeJS.ProcessEnv {
  const { NODE_COMPILE_CACHE: _inherited, ...env } = process.env;
  return env;
}

const CACHE_PREFIX = 'slicc-kernel-cc-';

function cacheDirOf(dir: unknown): { dir: string; own: boolean } | undefined {
  if (dir === false) return undefined;
  if (dir === undefined) return ownCacheDir();
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    throw new TypeError(
      'createNodeKernel: compileCache must be an absolute directory path or false'
    );
  }
  return { dir, own: false };
}

function cacheData(
  cache: { dir: string; own: boolean } | undefined
): { compileCache: string; ownedCache?: boolean } | undefined {
  if (!cache) return undefined;
  return { compileCache: cache.dir, ...(cache.own ? { ownedCache: true } : {}) };
}

function dropCache(cache: { dir: string; own: boolean } | undefined): void {
  if (!cache?.own) return;
  try {
    rmSync(cache.dir, { recursive: true, force: true });
  } catch {}
}

function ownCacheDir(
  make: () => string = privateCacheDir
): { dir: string; own: boolean } | undefined {
  try {
    return { dir: make(), own: true };
  } catch {
    return undefined;
  }
}

export { ownCacheDir };

let swept = false;

export function privateCacheDir(
  base = tmpdir(),
  alive = pidAlive,
  uid: number | undefined = process.getuid?.()
): string {
  const parent = cacheParent(base, uid);
  if (!swept) {
    swept = true;
    sweepCacheDirs(parent, alive, uid);
  }
  return mkdtempSync(join(parent, `${process.pid}-`));
}

function cacheParent(base: string, uid: number | undefined): string {
  const parent = join(base, uid === undefined ? 'slicc-kernel-cc' : `${CACHE_PREFIX}u${uid}`);
  try {
    mkdirSync(parent, { mode: 0o700 });
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err;
  }
  const st = lstatSync(parent);
  if (!st.isDirectory() || (uid !== undefined && (st.uid !== uid || (st.mode & 0o077) !== 0))) {
    throw new Error(`slicc-kernel: ${parent} is not a private directory of this user`);
  }
  return parent;
}

export function sweepCacheDirs(
  parent: string,
  alive: (pid: number) => boolean = pidAlive,
  uid: number | undefined = process.getuid?.()
): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(name.split('-')[0]);
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    removeOurs(join(parent, name), uid);
  }
}

function removeOurs(path: string, uid: number | undefined): void {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return;
    rmSync(path, { recursive: true, force: true });
  } catch {}
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

let nodeSessions = 0;

function nodeClient(
  launcher: Launcher,
  clients: Set<ServedClient>,
  { user, tag, requests }: ConnectOptions
): MessagePort {
  tagOption(tag);
  const { port1, port2 } = new MessageChannel();
  const session = ++nodeSessions;
  const served = serveClient(port1 as unknown as MessagePortLike, {
    launcher: async () => launcher,
    signal: signalNumber,
    session,
    ...(requests === 'attach' ? { attachRequests: true } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(tag !== undefined ? { tag } : {}),
  });
  clients.add(served);
  const unbind =
    requests && requests !== 'attach'
      ? launcher.embedder.register(session, checkedRequests(requests))
      : undefined;
  void served.closed.then(() => {
    clients.delete(served);
    unbind?.();
  });
  return port2 as unknown as MessagePort;
}

function checkedRequests(hook: EmbedderHook): EmbedderHook {
  const kinds = kindsOf(hook);
  return { kinds, handle: (request) => hook.handle(request) };
}

export async function createNodeKernel(options: NodeKernelOptions = {}): Promise<NodeKernel> {
  const hooks = sealedHooks(options.sealed);
  const root = options.root ?? memoryRoot();
  const fs = new OpfsFs(root, undefined, undefined, { ranged: isMemoryRoot(root) });
  await fs.reconcile();
  const live = new Set<() => void>();
  const pending = new Set<(err: Error) => void>();
  const clients = new Set<ServedClient>();
  let terminated = false;
  const file = options.worker ?? new URL('./node-process-worker.cjs', import.meta.url);
  const cache = cacheDirOf(options.compileCache);
  const workerData = cacheData(cache);
  const warm = warmPoolOf(options, file, workerData, live);
  const transport = options.network?.transport;
  const launcher = new Launcher({
    fs,
    moduleUrl: sourceModule,
    unlinkOwner: pidOwner(process),
    createWorker: () =>
      nodeWorker(file, live, terminated, workerData, warm ? () => warm.take() : undefined, true),
    createDriverWorker: () =>
      nodeWorker(
        options.driverWorker ?? new URL('./node-driver-worker.js', import.meta.url),
        live,
        terminated
      ),
    ...(options.modules ? { modules: options.modules } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(transport ? { transport } : {}),
    ...(options.network?.uplink ? { uplink: options.network.uplink } : {}),
    ...(options.network?.doh !== undefined ? { doh: options.network.doh } : {}),
    ...(options.processMounts !== undefined ? { processMounts: options.processMounts } : {}),
    ...(options.fstabRetries ? { fstabRetries: options.fstabRetries } : {}),
    ...(options.hostfs ? { hostfs: options.hostfs } : {}),
    ...hostfsFetchOf(options),
    ...(options.cdp ? { cdp: options.cdp } : {}),
    ...(options.facades ? { facades: options.facades } : {}),
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    users: options.users === undefined ? DEFAULT_USERS : options.users,
    ...(options.onDenial ? { onDenial: options.onDenial } : {}),
    ...(options.protect ? { protect: options.protect } : {}),
    ...(hooks.request ? { sealed: hooks.request } : {}),
    ...(hooks.fetch ? { sealedFetch: hooks.fetch } : {}),
    ...(options.clipboard ? { clipboard: options.clipboard } : {}),
    ...(options.requests ? { embedder: checkedRequests(options.requests) } : {}),
    ...(options.approve ? { approve: options.approve } : {}),
    ...(options.wasmMemories ? { wasmMemories: options.wasmMemories } : {}),
    cron: { lock: cronLock(root), ...(options.cron?.clock ? { clock: options.cron.clock } : {}) },
  });
  await launcher.prepare();
  const guard = <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (terminated) return reject(new Error(TERMINATED));
      pending.add(reject);
      work()
        .then(resolve, reject)
        .finally(() => pending.delete(reject));
    });
  const decoder = new TextDecoder();
  return {
    root,
    async run(argv, opts = {}) {
      const { stdin, onStdout, onStderr, ...rest } = opts;
      const onOut = textOf(onStdout);
      const onErr = textOf(onStderr);
      const result = await guard(() =>
        launcher.run(argv, {
          ...rest,
          ...(stdin !== undefined
            ? { stdin: typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin }
            : {}),
          ...(onOut ? { onStdout: onOut } : {}),
          ...(onErr ? { onStderr: onErr } : {}),
        })
      );
      return {
        status: result.status,
        ...signalField(result.signal),
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
    async openTerminal(argv, opts = {}) {
      const { onData, ...rest } = opts;
      let listener = onData ?? null;
      const backlog: Uint8Array[] = [];
      const session = await guard(() =>
        launcher.openTerminal(argv, {
          ...rest,
          onData: (bytes) => (listener ? listener(bytes) : backlog.push(bytes)),
        })
      );
      return {
        pid: session.pid,
        exited: quiet(guard(() => session.exited)),
        ended: quiet(
          guard(async () => ({ status: await session.exited, ...signalField(session.termsig()) }))
        ),
        get onData() {
          return listener;
        },
        set onData(next) {
          listener = next;
          if (next) for (const bytes of backlog.splice(0)) next(bytes);
        },
        write: (data) =>
          session.write(typeof data === 'string' ? new TextEncoder().encode(data) : data),
        resize: (cols, rows) => session.resize(cols, rows),
        signal: (name) => session.signal(signalNumber(name)),
        close: () => session.close(),
      };
    },
    async writeFile(path, data, options = {}) {
      const mode = options.mode === undefined ? undefined : modeOption(options.mode);
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      await launcher.fs.mkdir(parent, { recursive: true });
      if (mode !== undefined) {
        await launcher.fs.writeFile(path, '');
        await launcher.fs.chmod(path, mode);
      }
      await launcher.fs.writeFile(path, data);
    },
    chmod: async (path, mode) => launcher.fs.chmod(path, modeOption(mode)),
    integrity: { revoke: (path) => guard(() => launcher.revokeIntegrity(path)) },
    sealed: { setPlaceholders: (list) => guard(async () => launcher.setPlaceholders(list)) },
    attest: ((path, attestOptions) =>
      guard(() => launcher.attest(path, attestOptions))) as NodeKernel['attest'],
    readFile: async (path) => launcher.fs.readFileBuffer(path),
    mount: (spec) => guard(() => launcher.mount(spec)),
    umount: (target) => guard(async () => launcher.umount(target)),
    mounts: async () => launcher.mounts.listed(),
    setRoutes: (routes) => guard(async () => launcher.setRoutes(routes)),
    updateTransportTraits: () => guard(async () => launcher.updateTransportTraits()),
    users: {
      mode: launcher.usersMode,
      add: (user) => guard(() => launcher.users.add(user)),
      remove: (name, options) => guard(() => launcher.users.remove(name, options)),
      list: () => guard(() => launcher.users.list()),
    },
    groups: {
      list: () => guard(() => launcher.users.groups()),
      addMember: (group, user) => guard(() => launcher.users.addMember(group, user)),
      removeMember: (group, user) => guard(() => launcher.users.removeMember(group, user)),
    },
    async connect(connectOptions = {}) {
      if (terminated) throw new Error(TERMINATED);
      const { user } = connectOptions;
      if (user !== undefined && !(await guard(() => launcher.users.lookup(user)))) {
        throw fsError('ENOENT', `no user ${String(user)}`);
      }
      return nodeClient(launcher, clients, connectOptions);
    },
    terminate() {
      terminated = true;
      warm?.close();
      for (const client of [...clients]) client.detach();
      for (const reject of [...pending]) reject(new Error(TERMINATED));
      for (const kill of [...live]) kill();
      launcher.cdp.close();
      launcher.endFills();
      launcher.unmountAll();
      dropCache(cache);
    },
  };
}
