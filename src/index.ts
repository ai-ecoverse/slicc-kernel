import { type CdpOpen, serveCdpPort } from './cdp/port.ts';
import type { CdpHook } from './cdp/types.ts';
import {
  type DialHandle,
  type DialledSocket,
  type DialOptions,
  dialStream,
  errorWithCode,
} from './client/dial-stream.ts';
import { type LoopbackFetchOptions, loopbackFetch } from './client/loopback-fetch.ts';
import { clipboardAnswerer } from './clipboard-relay.ts';
import { type FacadeOpen, serveFacadePort } from './facade/port.ts';
import type { FacadeSpecs } from './facade/types.ts';
import type { Attestation } from './fs/attest.ts';
import type { Denial, DenialHook } from './fs/dac.ts';
import { integrityOptions } from './fs/integrity.ts';
import { type Protection, protectInit } from './fs/protect.ts';
import { DEFAULT_USERS, type UsersMode } from './fs/types.ts';
import { integrityAnswerer } from './integrity-relay.ts';
import type { ClipboardHook } from './kernel/clipboard.ts';
import { isHostname } from './kernel/net/loopback-names.ts';
import type { TransportCall } from './kernel/net/remote-transport.ts';
import type { RouteTable } from './kernel/net/routes.ts';
import {
  carriesUdp,
  type NetworkUplink,
  serveUplink,
  type UplinkCall,
} from './kernel/net/uplink.ts';
import type { SealedHook } from './kernel/sealed.ts';
import { quiet, signalField } from './kernel/signals.ts';
import type { PendingMedium } from './launcher.ts';
import type { MediumHandle } from './mount/fsa.ts';
import type { HostfsGrantHook } from './mount/hostfs.ts';
import type { MountEntry, MountSpec } from './mount/mount-fs.ts';
import type { ProcessMountPolicy, ProcessMountRequest } from './mount/syscall.ts';
import { sealedAnswerer } from './sealed-relay.ts';
import type { FileChanged, InitRequest, KernelCall, TerminalAction } from './serve.ts';
import type { ApproveHook, SudoRequest } from './sudo.ts';
import { type NetworkTransport, serveTransport } from './transport.ts';
import type { Account, AddUser, Group, RemoveUser } from './users.ts';

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
export type { DialledSocket, DialOptions } from './client/dial-stream.ts';
export type { LoopbackFetchOptions } from './client/loopback-fetch.ts';
export type {
  FacadeConnection,
  FacadeHook,
  FacadeInfo,
  FacadeSpec,
  FacadeSpecs,
} from './facade/types.ts';
export type { Attestation, AttestedDir } from './fs/attest.ts';
export type { Denial, DenialHook } from './fs/dac.ts';
export type { ClipboardHook, ClipboardStamp } from './kernel/clipboard.ts';
export type { RouteTable } from './kernel/net/routes.ts';
export type {
  NetworkUplink,
  ResolveAnswer,
  ResolveFamily,
  UplinkTraits,
} from './kernel/net/uplink.ts';
export type {
  SealedAbortReason,
  SealedCaller,
  SealedHook,
  SealedRequest,
} from './kernel/sealed.ts';
export type { ConnectorStamp } from './kernel/socket.ts';
export {
  checkLocalProxy,
  type LocalProxyCheckOptions,
  type LocalProxyOptions,
  type LocalProxyProbe,
  type LocalProxyStatus,
  type LocalProxyTransportOptions,
  localProxyTransport,
  probeLocalProxy,
} from './local-proxy-transport.ts';
export type {
  HostfsEvent,
  HostfsGrant,
  HostfsGrantHook,
  HostfsPortGrant,
  HostfsTransport,
} from './mount/hostfs.ts';
export { serveHostfsPort } from './mount/hostfs.ts';
export type { MountEntry, MountSpec } from './mount/mount-fs.ts';
export type { ProcessMountPolicy, ProcessMountRequest } from './mount/syscall.ts';
export type { JsChild, JsExited, JsSpawnOptions, JsStdio } from './process/js/js-children.ts';
export type {
  JsFdStatus,
  JsFdType,
  JsFile,
  JsOpenOptions,
  JsProgramContext,
  JsSignal,
  JsSudoAnswer,
} from './process/js/js-context.ts';
export type { JsStatFs } from './process/js/js-io.ts';
export type {
  JsAddress,
  JsConnection,
  JsConnectOptions,
  JsListener,
  JsListenOptions,
  JsNet,
} from './process/js/js-net.ts';
export type { JsRunOptions, JsRunResult, JsRunStdio } from './process/js/js-run.ts';
export type { JsCred, JsSyncContext, JsSyncFile } from './process/js/js-sync.ts';
export type { JsTermios, JsTty, JsTtySize } from './process/js/js-tty.ts';
export type {
  JsWebSocket,
  JsWebSocketClose,
  JsWebSocketMessage,
  JsWebSocketOptions,
} from './process/js/js-websocket.ts';
export type { ApproveHook, SudoAnswer, SudoRequest } from './sudo.ts';
export {
  type FetchTransportOptions,
  fetchTransport,
  type HeaderList,
  type NetworkRequest,
  type NetworkResponse,
  type NetworkTraits,
  type NetworkTransport,
  type NetworkWebSocket,
  type NetworkWebSocketRequest,
} from './transport.ts';
export type { Account, AddUser, Group, RemoveUser } from './users.ts';

export interface NetworkOptions {
  transport?: NetworkTransport;
  uplink?: NetworkUplink;
}

export interface KernelOptions {
  root?: FileSystemDirectoryHandle;
  modules?: string;
  commands?: { append?: readonly string[] };
  env?: Record<string, string>;
  metadata?: string | false;
  media?: string | false;
  ca?: string | false;
  worker?: string | URL;
  network?: NetworkOptions;
  requestDirectory?: () => Promise<FileSystemDirectoryHandle>;
  onMountPending?: (pending: MountPending) => void;
  hostfs?: HostfsGrantHook;
  processMounts?: ProcessMountPolicy;
  cdp?: CdpHook;
  facades?: FacadeSpecs;
  hostname?: string;
  users?: UsersMode;
  onDenial?: DenialHook;
  sealed?: SealedHook;
  clipboard?: ClipboardHook;
  approve?: ApproveHook;
  protect?: Protection;
}

interface HostfsRequest {
  id: number;
  source: string;
  readonly: boolean;
}

export interface MountPending {
  target: string;
  source: string;
  insert(): Promise<void>;
}

export interface RunOptions {
  cwd?: string;
  user?: string | number;
  tag?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface RunResult {
  status: number;
  signal?: string;
  stdout: string;
  stderr: string;
}

export interface ConnectOptions {
  user?: string | number;
  tag?: string;
}

export interface KernelGroups {
  list(): Promise<Group[]>;
  addMember(group: string, user: string): Promise<Group>;
  removeMember(group: string, user: string): Promise<Group>;
}

export interface KernelUsers {
  readonly mode: UsersMode;
  add(user: AddUser): Promise<Account>;
  remove(name: string, options?: RemoveUser): Promise<boolean>;
  list(): Promise<Account[]>;
}

export interface KernelIntegrity {
  revoke(path?: string): Promise<void>;
}

export interface Kernel {
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  openTerminal(argv: string[], options?: TerminalOptions): Promise<Terminal>;
  connect(options?: ConnectOptions): Promise<MessagePort>;
  readonly users: KernelUsers;
  readonly groups: KernelGroups;
  setRoutes(routes: RouteTable): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readonly integrity: KernelIntegrity;
  updateTransportTraits(): Promise<boolean>;
  dial(options: DialOptions): Promise<DialledSocket>;
  loopbackFetch(input: RequestInfo | URL, options: LoopbackFetchOptions): Promise<Response>;
  mount(spec: MountSpec): Promise<MountEntry>;
  umount(target: string): Promise<void>;
  mounts(): Promise<MountEntry[]>;
  insert(target: string, handle: FileSystemDirectoryHandle): Promise<void>;
  attest(path: string): Promise<Attestation>;
  watch(paths: string[], onChange: (path: string) => void): Promise<() => void>;
  terminate(): void;
}

export interface TerminalOptions {
  cwd?: string;
  user?: string | number;
  tag?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  onData?: (bytes: Uint8Array) => void;
}

export type TerminalSignal =
  | 'SIGINT'
  | 'SIGTSTP'
  | 'SIGQUIT'
  | 'SIGHUP'
  | 'SIGTERM'
  | 'SIGKILL'
  | 'SIGCONT';

export interface Ended {
  status: number;
  signal?: string;
}

export interface Terminal {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly ended: Promise<Ended>;
  onData: ((bytes: Uint8Array) => void) | null;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  signal(name: TerminalSignal): void;
  close(): void;
}

interface Reply {
  id: number;
  result?: unknown;
  error?: string;
  code?: string;
  fd?: 1 | 2;
  bytes?: Uint8Array;
  started?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  output?: (fd: 1 | 2, bytes: Uint8Array) => void;
  started?: (pid: number) => void;
}

interface Handlers {
  output?: Pending['output'];
  started?: Pending['started'];
}

const ISOLATION =
  'slicc-kernel needs a cross-origin isolated page (Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp or credentialless)';

function streamer(callback: ((text: string) => void) | undefined) {
  const decoder = new TextDecoder();
  return (bytes: Uint8Array) => callback?.(decoder.decode(bytes, { stream: true }));
}

function dialer(call: (req: KernelCall) => Promise<unknown>) {
  const open = new Set<DialHandle>();
  const dial = async ({ port, host }: DialOptions): Promise<DialledSocket> => {
    let reply: unknown;
    try {
      reply = await call({ op: 'dial', port, ...(host ? { host } : {}) });
    } catch (err) {
      throw errorWithCode((err as Error).message);
    }
    const handle = dialStream(reply as MessagePort, () => open.delete(handle));
    open.add(handle);
    return handle;
  };
  const reset = () => {
    for (const handle of [...open]) handle.fail(errorWithCode('ECONNRESET: the kernel is gone'));
  };
  return { dial, reset };
}

function uplinkInit(uplink: NetworkUplink | undefined): Pick<InitRequest, 'uplink'> {
  if (!uplink) return {};
  const traits = { tcp: true, udp: carriesUdp(uplink), ipv6: uplink.traits.ipv6 === true } as const;
  return { uplink: { traits, ...(uplink.routes ? { routes: uplink.routes } : {}) } };
}

function initCall(options: KernelOptions, transport: NetworkTransport | undefined): KernelCall {
  return {
    op: 'init',
    ...(options.root ? { root: options.root } : {}),
    ...(options.modules ? { modules: options.modules } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    ...(options.media !== undefined ? { media: options.media } : {}),
    ...(options.ca !== undefined ? { ca: options.ca } : {}),
    ...(transport ? { transport: transport.traits } : {}),
    ...uplinkInit(options.network?.uplink),
    ...(options.hostfs ? { hostfs: true } : {}),
    ...(options.cdp ? { cdp: true } : {}),
    ...facadesInit(options.facades),
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    users: options.users === undefined ? DEFAULT_USERS : options.users,
    ...(options.onDenial ? { denials: true } : {}),
    ...(options.sealed ? { sealed: true } : {}),
    ...(options.clipboard ? { clipboard: true } : {}),
    ...(options.approve ? { approve: true } : {}),
    ...(options.protect ? { protect: protectInit(options.protect) } : {}),
    ...(options.processMounts !== undefined
      ? {
          processMounts:
            typeof options.processMounts === 'function' ? 'ask' : options.processMounts,
        }
      : {}),
  };
}

interface PageHosts {
  cdp: { open(data: CdpOpen): void };
  facades: { open(data: FacadeOpen): void };
  policy(data: { id: number; req: ProcessMountRequest }): Promise<void>;
  medium(medium: PendingMedium): void;
  hostfs(req: HostfsRequest): Promise<void>;
}

function hostedMessage(data: WorkerMessage, on: PageHosts): data is Exclude<WorkerMessage, Reply> {
  if ('cdpOpen' in data) on.cdp.open(data);
  else if ('facadeOpen' in data) on.facades.open(data);
  else if ('mountPolicy' in data) void on.policy(data.mountPolicy);
  else if ('medium' in data) on.medium(data.medium);
  else if ('hostfs' in data) void on.hostfs(data.hostfs);
  else return false;
  return true;
}

function facadesInit(specs: FacadeSpecs | undefined) {
  if (!specs) return {};
  const facades: Record<string, { port: number; hook?: boolean }> = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (spec?.hook !== undefined && typeof spec.hook !== 'function') {
      throw new TypeError(`facades.${name}: hook must be a function`);
    }
    facades[name] = { port: spec?.port, ...(spec?.hook ? { hook: true } : {}) };
  }
  return { facades };
}

function facadeBridge(specs: FacadeSpecs | undefined) {
  const open = new Set<() => void>();
  let closed = false;
  return {
    open({ facadeOpen, port }: FacadeOpen): void {
      const hook = specs?.[facadeOpen.name]?.hook;
      if (!hook || closed) {
        port.postMessage({ error: 'no facade host' });
        port.close();
        return;
      }
      const close = serveFacadePort(port, hook, facadeOpen, () => open.delete(close));
      open.add(close);
    },
    close(): void {
      closed = true;
      for (const close of [...open]) close();
    },
  };
}

function cdpBridge(hook: CdpHook | undefined) {
  const open = new Set<() => void>();
  let closed = false;
  return {
    open({ cdpOpen, port }: CdpOpen): void {
      if (!hook || closed) {
        port.close();
        return;
      }
      const close = serveCdpPort(port, hook, cdpOpen, () => open.delete(close));
      open.add(close);
    },
    close(): void {
      closed = true;
      for (const close of [...open]) close();
    },
  };
}

function failed(message: string, code: string | undefined): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

function kernelGroups(call: (req: KernelCall) => Promise<unknown>): KernelGroups {
  const member =
    (op: 'groups-add-member' | 'groups-remove-member') => async (group: string, user: string) =>
      (await call({ op, group, user })) as Group;
  return {
    list: async () => (await call({ op: 'groups-list' })) as Group[],
    addMember: member('groups-add-member'),
    removeMember: member('groups-remove-member'),
  };
}

function accounts(
  call: (req: KernelCall) => Promise<unknown>,
  mode: UsersMode | undefined
): { users: KernelUsers; groups: KernelGroups } {
  return { users: kernelUsers(call, mode), groups: kernelGroups(call) };
}

function kernelUsers(
  call: (req: KernelCall) => Promise<unknown>,
  mode: UsersMode = DEFAULT_USERS
): KernelUsers {
  return {
    mode,
    add: async (user) => (await call({ op: 'users-add', user })) as Account,
    remove: async (name, options) =>
      (await call({ op: 'users-remove', name, ...(options ? { options } : {}) })) as boolean,
    list: async () => (await call({ op: 'users-list' })) as Account[],
  };
}

async function mountPolicy(
  options: KernelOptions,
  worker: Worker,
  { id, req }: { id: number; req: ProcessMountRequest }
): Promise<void> {
  const decide = options.processMounts;
  let allowed = false;
  try {
    allowed = typeof decide === 'function' ? await decide(req) : decide !== false;
  } catch {}
  worker.postMessage({ mountAllowed: { id, allowed } });
}

type SudoMessage = { sudoAsk: SudoRequest } | { sudoAbort: { id: string; reason: string } };

type WorkerMessage =
  | Reply
  | TransportCall
  | UplinkCall
  | { medium: PendingMedium }
  | { hostfs: HostfsRequest }
  | { mountPolicy: { id: number; req: ProcessMountRequest } }
  | CdpOpen
  | FacadeOpen
  | { denial: Denial }
  | FileChanged
  | SudoMessage;

type Requester = (req: KernelCall) => { id: number; done: Promise<unknown> };

function fileWatches(request: Requester, call: (req: KernelCall) => Promise<unknown>) {
  const watching = new Map<number, (path: string) => void>();
  return {
    event(data: WorkerMessage): data is FileChanged {
      if (!('fileChanged' in data)) return false;
      watching.get(data.fileChanged.watch)?.(data.fileChanged.path);
      return true;
    },
    async watch(paths: string[], onChange: (path: string) => void): Promise<() => void> {
      const { id, done } = request({ op: 'watch-files', paths });
      watching.set(id, onChange);
      await done.catch((err: unknown) => {
        watching.delete(id);
        throw err;
      });
      return () => {
        if (!watching.delete(id)) return;
        void call({ op: 'unwatch-files', watch: id }).catch(() => undefined);
      };
    },
  };
}

function approver(approve: ApproveHook | undefined, worker: Worker) {
  const asked = new Map<string, AbortController>();
  const handlers = {
    handle(data: WorkerMessage): data is SudoMessage {
      if ('sudoAsk' in data) void handlers.ask(data.sudoAsk);
      else if ('sudoAbort' in data) handlers.abort(data.sudoAbort);
      else return false;
      return true;
    },
    async ask(req: SudoRequest): Promise<void> {
      const control = new AbortController();
      asked.set(req.id, control);
      let answer: unknown = 'deny';
      try {
        answer = await approve?.(req, { signal: control.signal });
      } catch {}
      asked.delete(req.id);
      if (control.signal.aborted) return;
      worker.postMessage({ sudoAnswer: { id: req.id, answer } });
    },
    abort({ id, reason }: { id: string; reason: string }): void {
      asked.get(id)?.abort(reason);
      asked.delete(id);
    },
    close(): void {
      for (const control of asked.values()) control.abort('withdrawn');
      asked.clear();
    },
  };
  return handlers;
}

function checkOptions(options: KernelOptions): void {
  if (!globalThis.crossOriginIsolated) throw new Error(ISOLATION);
  if (options.hostname !== undefined && !isHostname(options.hostname)) {
    throw new Error(`not a host name: ${String(options.hostname)}`);
  }
  if (options.protect) protectInit(options.protect);
  integrityOptions(options.protect?.integrity);
  facadesInit(options.facades);
}

function hookRelays(
  worker: Worker,
  options: KernelOptions
): { handle(data: unknown): boolean; close(): void } {
  const sealed = sealedAnswerer(worker, options.sealed);
  const clipboard = clipboardAnswerer(worker, options.clipboard);
  const integrity = integrityAnswerer(worker, options.protect?.integrity?.lookup);
  return {
    handle: (data) => sealed.handle(data) || clipboard.handle(data) || integrity(data),
    close: () => sealed.close(),
  };
}

interface RawRun {
  status: number;
  signal?: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function decodedRun(result: RawRun): RunResult {
  const decoder = new TextDecoder();
  return {
    status: result.status,
    ...signalField(result.signal),
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function endedOf(r: unknown): Ended {
  if (typeof r === 'number') return { status: r };
  const { status, signal } = r as { status: number; signal?: number };
  return { status, ...signalField(signal) };
}

function uplinkServer(
  worker: Worker,
  uplink: NetworkUplink | undefined
): ReturnType<typeof serveUplink> | undefined {
  return uplink ? serveUplink(worker, uplink) : undefined;
}

function traitsUpdater(
  transport: NetworkTransport | undefined,
  call: (req: KernelCall) => Promise<unknown>
): () => Promise<boolean> {
  return async () => {
    const traits = transport ? { traits: { ...transport.traits } } : {};
    return (await call({ op: 'transport-traits', ...traits })) === true;
  };
}

export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  checkOptions(options);
  const url = options.worker ?? new URL('./kernel-worker.js', import.meta.url);
  const worker = new Worker(url, { type: 'module', name: 'slicc-kernel' });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let failure: Error | undefined;

  const dials = dialer((req) => call(req));
  const files = fileWatches(
    (req) => request(req),
    (req) => call(req)
  );
  const cdp = cdpBridge(options.cdp);
  const facades = facadeBridge(options.facades);
  const sealed = hookRelays(worker, options);
  const approvals = approver(options.approve, worker);
  const fail = (error: Error) => {
    dials.reset();
    cdp.close();
    facades.close();
    sealed.close();
    approvals.close();
    failure = error;
    bridge?.close();
    uplinks?.close();
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  const transport = options.network?.transport;
  const bridge = transport ? serveTransport(worker, transport) : undefined;
  const uplinks = uplinkServer(worker, options.network?.uplink);
  async function chosen(handle: MediumHandle | undefined): Promise<FileSystemDirectoryHandle> {
    if (handle) {
      const state = await handle.requestPermission?.({ mode: 'readwrite' });
      if (state === undefined || state === 'granted') return handle;
      throw new Error('permission for the folder was not granted');
    }
    if (!options.requestDirectory) throw new Error('this page cannot ask for a folder');
    return options.requestDirectory();
  }
  async function grantHostfs({ id, source, readonly }: HostfsRequest): Promise<void> {
    try {
      if (!options.hostfs) throw new Error('this page gives no host folders');
      const grant = await options.hostfs(source, { readonly });
      worker.postMessage({ hostfsGrant: { id, grant } }, 'port' in grant ? [grant.port] : []);
    } catch (err) {
      worker.postMessage({ hostfsGrant: { id, error: (err as Error).message ?? String(err) } });
    }
  }
  const policy = (asked: { id: number; req: ProcessMountRequest }) =>
    mountPolicy(options, worker, asked);
  const pendingMedium = ({ target, source, handle }: PendingMedium) =>
    options.onMountPending?.({
      target,
      source,
      insert: async () =>
        void (await call({ op: 'insert', target, source, handle: await chosen(handle) })),
    });
  const aside = (data: WorkerMessage): data is { denial: Denial } | FileChanged => {
    if (files.event(data)) return true;
    if (!('denial' in data)) return sealed.handle(data);
    options.onDenial?.(data.denial);
    return true;
  };
  const hosts = { cdp, facades, policy, medium: pendingMedium, hostfs: grantHostfs };
  worker.addEventListener('message', ({ data }: MessageEvent<WorkerMessage>) => {
    if (aside(data)) return;
    if (approvals.handle(data)) return;
    if ('net' in data) return bridge?.answer(data);
    if ('uplink' in data) return uplinks?.answer(data);
    if (hostedMessage(data, hosts)) return;
    const call = pending.get(data.id);
    if (!call) return;
    if (data.fd !== undefined) return call.output?.(data.fd, data.bytes as Uint8Array);
    if (data.started !== undefined) return call.started?.(data.started);
    pending.delete(data.id);
    if (data.error !== undefined) call.reject(failed(data.error, data.code));
    else call.resolve(data.result);
  });
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    fail(new Error(`slicc-kernel worker failed: ${event.message}`));
  });

  function request(
    req: KernelCall,
    handlers: Handlers = {}
  ): { id: number; done: Promise<unknown> } {
    const id = ++nextId;
    if (failure) return { id, done: Promise.reject(failure) };
    const done = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, ...handlers });
      worker.postMessage({ ...req, id });
    });
    return { id, done };
  }

  const call = (req: KernelCall, handlers?: Handlers) => request(req, handlers).done;

  async function openTerminal(argv: string[], opts: TerminalOptions = {}): Promise<Terminal> {
    const { onData, ...options } = opts;
    let listener = onData ?? null;
    const backlog: Uint8Array[] = [];
    const started = Promise.withResolvers<number>();
    const { id, done } = request(
      { op: 'open-terminal', argv, options },
      {
        output: (_fd, bytes) => (listener ? listener(bytes) : backlog.push(bytes)),
        started: started.resolve,
      }
    );
    done.catch(started.reject);
    const pid = await started.promise;
    const send = (action: TerminalAction) =>
      void call({ op: 'terminal', terminal: id, ...action }).catch(() => undefined);
    return {
      pid,
      exited: quiet(done.then((r) => endedOf(r).status)),
      ended: quiet(done.then(endedOf)),
      get onData() {
        return listener;
      },
      set onData(next) {
        listener = next;
        if (next) for (const bytes of backlog.splice(0)) next(bytes);
      },
      write: (data) =>
        send({
          action: 'write',
          bytes: typeof data === 'string' ? new TextEncoder().encode(data) : data,
        }),
      resize: (cols, rows) => send({ action: 'resize', cols, rows }),
      signal: (name) => send({ action: 'signal', signal: name }),
      close: () => send({ action: 'close' }),
    };
  }

  const { dial } = dials;

  await call(initCall(options, transport));

  return {
    async run(argv, runOptions = {}) {
      const { onStdout, onStderr, stdin, ...rest } = runOptions;
      const streams = { 1: streamer(onStdout), 2: streamer(onStderr) };
      const input = typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin;
      const result = (await call(
        { op: 'run', argv, options: { ...rest, ...(input ? { stdin: input } : {}) } },
        { output: (fd, bytes) => streams[fd](bytes) }
      )) as RawRun;
      return decodedRun(result);
    },
    openTerminal,
    connect: async (connectOptions = {}) =>
      (await call({ op: 'connect', ...connectOptions })) as MessagePort,
    ...accounts(call, options.users === undefined ? DEFAULT_USERS : options.users),
    setRoutes: async (routes) => void (await call({ op: 'routes', routes })),
    chmod: async (path, mode) => void (await call({ op: 'chmod', path, mode })),
    integrity: {
      revoke: async (path) =>
        void (await call({ op: 'integrity-revoke', ...(path !== undefined ? { path } : {}) })),
    },
    updateTransportTraits: traitsUpdater(transport, call),
    dial,
    loopbackFetch: (input, fetchOptions) => loopbackFetch(dial, input, fetchOptions),
    mount: async (spec) => (await call({ op: 'mount', spec })) as MountEntry,
    umount: async (target) => void (await call({ op: 'umount', target })),
    mounts: async () => (await call({ op: 'mounts' })) as MountEntry[],
    insert: async (target, handle) => void (await call({ op: 'insert', target, handle })),
    attest: async (path) => (await call({ op: 'attest', path })) as Attestation,
    watch: files.watch,
    terminate() {
      fail(new Error('slicc-kernel terminated'));
      worker.terminate();
    },
  };
}
