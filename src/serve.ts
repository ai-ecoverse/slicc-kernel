import { portCdpHook } from './cdp/port.ts';
import type { CdpHook } from './cdp/types.ts';
import { type LockManagerLike, locksOf } from './client/protocol.ts';
import { type ServedClient, serveClient } from './client/serve-client.ts';
import { type ClipboardReply, clipboardAsker } from './clipboard-relay.ts';
import type { Attestation } from './fs/attest.ts';
import type { Denial, DenialHook } from './fs/dac.ts';
import type { IntegrityLookup } from './fs/integrity.ts';
import { META_DB, type MetaStore } from './fs/meta.ts';
import { OpfsFs } from './fs/opfs.ts';
import { type ProtectInit, type Protection, protectInit } from './fs/protect.ts';
import { fsError, modeOption, type UsersMode } from './fs/types.ts';
import { type IntegrityReply, integrityAsker } from './integrity-relay.ts';
import type { ClipboardHook } from './kernel/clipboard.ts';
import { dialSocket, serveSocket } from './kernel/dial.ts';
import type { WasmWorkerLike } from './kernel/host.ts';
import { CA_DB, caStore } from './kernel/net/network.ts';
import { RemoteTransport, type TransportReply } from './kernel/net/remote-transport.ts';
import type { RouteTable } from './kernel/net/routes.ts';
import type { RealmTransportTraits } from './kernel/net/transport.ts';
import { RemoteUplink, type UplinkReply, type UplinkTraits } from './kernel/net/uplink.ts';
import type { SealedHook } from './kernel/sealed.ts';
import { SIG } from './kernel/signals.ts';
import {
  Launcher,
  type RunOptions,
  type TerminalOptions,
  type TerminalSession,
  tagOption,
} from './launcher.ts';
import type { MediumHandle } from './mount/fsa.ts';
import type { HostfsGrant, HostfsGrantHook, HostfsPortGrant } from './mount/hostfs.ts';
import type { MediaStore } from './mount/media.ts';
import type { MountSpec } from './mount/mount-fs.ts';
import type { ProcessMountRequest } from './mount/syscall.ts';
import { type SealedReply, sealedAsker } from './sealed-relay.ts';
import type { ApproveHook, SudoAnswer } from './sudo.ts';
import type { AddUser, RemoveUser } from './users.ts';

export interface KernelPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

export interface InitRequest {
  id: number;
  op: 'init';
  root?: FileSystemDirectoryHandle;
  modules?: string;
  commands?: { append?: readonly string[] };
  env?: Record<string, string>;
  metadata?: string | false;
  media?: string | false;
  ca?: string | false;
  transport?: RealmTransportTraits;
  uplink?: { traits: UplinkTraits; routes?: RouteTable };
  hostfs?: boolean;
  hostname?: string;
  users?: UsersMode;
  protect?: ProtectInit;
  denials?: boolean;
  sealed?: boolean;
  clipboard?: boolean;
  approve?: boolean;
  processMounts?: boolean | 'ask';
  cdp?: boolean;
}

export interface RunRequest {
  id: number;
  op: 'run';
  argv: string[];
  options: Omit<RunOptions, 'onStdout' | 'onStderr'>;
}

export interface OpenTerminalRequest {
  id: number;
  op: 'open-terminal';
  argv: string[];
  options: Omit<TerminalOptions, 'onData'>;
}

export type TerminalAction =
  | { action: 'write'; bytes: Uint8Array }
  | { action: 'resize'; cols: number; rows: number }
  | { action: 'signal'; signal: string }
  | { action: 'close' };

export type TerminalRequest = { id: number; op: 'terminal'; terminal: number } & TerminalAction;

export interface ConnectRequest {
  id: number;
  op: 'connect';
  user?: string | number;
  tag?: string;
}

export type UsersRequest =
  | { id: number; op: 'users-add'; user: AddUser }
  | { id: number; op: 'users-remove'; name: string; options?: RemoveUser }
  | { id: number; op: 'users-list' }
  | { id: number; op: 'groups-list' }
  | { id: number; op: 'groups-add-member' | 'groups-remove-member'; group: string; user: string };

export interface RoutesRequest {
  id: number;
  op: 'routes';
  routes: RouteTable;
}

export interface TraitsRequest {
  id: number;
  op: 'transport-traits';
  traits?: RealmTransportTraits;
}

export type MountRequest =
  | { id: number; op: 'mount'; spec: MountSpec }
  | { id: number; op: 'umount'; target: string }
  | { id: number; op: 'mounts' }
  | { id: number; op: 'insert'; target: string; source?: string; handle: MediumHandle };

export interface DialRequest {
  id: number;
  op: 'dial';
  port: number;
  host?: string;
}

export type AttestRequest =
  | { id: number; op: 'attest'; path: string }
  | { id: number; op: 'chmod'; path: string; mode: number }
  | { id: number; op: 'watch-files'; paths: string[] }
  | { id: number; op: 'unwatch-files'; watch: number };

export interface FileChanged {
  fileChanged: { watch: number; path: string };
}

export type KernelRequest =
  | AttestRequest
  | InitRequest
  | RunRequest
  | OpenTerminalRequest
  | TerminalRequest
  | ConnectRequest
  | UsersRequest
  | MountRequest
  | DialRequest
  | RoutesRequest
  | TraitsRequest;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export type KernelCall = WithoutId<KernelRequest>;

function networkOp(
  l: Launcher,
  req: RoutesRequest | TraitsRequest,
  remote: RemoteTransport | undefined
): boolean {
  if (req.op === 'routes') {
    l.setRoutes(req.routes);
    return true;
  }
  if (remote && req.traits) remote.traits = req.traits;
  return l.updateTransportTraits();
}

export async function inOpfs(deps: ServeDeps, root: FileSystemDirectoryHandle): Promise<boolean> {
  if (deps.syncAccess !== true) return false;
  const opfs = await deps.storage().catch(() => undefined);
  return (await opfs?.resolve(root).catch(() => null)) != null;
}

export interface ServeDeps {
  storage: () => Promise<FileSystemDirectoryHandle>;
  syncAccess?: boolean;
  createWorker: () => WasmWorkerLike;
  createDriverWorker?: () => WasmWorkerLike;
  metadata?: (name: string) => Promise<MetaStore>;
  media?: (name: string) => Promise<MediaStore>;
  locks?: LockManagerLike | null;
}

export function signalNumber(name: string): number {
  const key = name.slice(3);
  if (!name.startsWith('SIG') || !Object.hasOwn(SIG, key))
    throw new Error(`unknown signal ${name}`);
  return (SIG as Record<string, number>)[key];
}

function act(session: TerminalSession, req: TerminalAction): void {
  if (req.action === 'write') session.write(req.bytes);
  else if (req.action === 'resize') session.resize(req.cols, req.rows);
  else if (req.action === 'signal') session.signal(signalNumber(req.signal));
  else session.close();
}

function dirsChannel(name: string | false): string | undefined {
  return name === false ? undefined : `slicc-kernel-dirs:${name}`;
}

function caDb(req: InitRequest): string | false {
  const name = req.ca ?? (req.metadata ? `${req.metadata}-ca` : CA_DB);
  const taken = [req.metadata ?? META_DB, req.media ?? `${req.metadata ?? META_DB}:media`];
  if (name !== false && taken.includes(name)) {
    throw new Error(`the CA cannot share the IndexedDB database ${name}`);
  }
  return name;
}

async function stores(
  deps: ServeDeps,
  name: string | false,
  media: string | false | undefined
): Promise<{ meta?: MetaStore | undefined; media?: MediaStore | undefined }> {
  const handles = media ?? (name === false ? false : `${name}:media`);
  if (handles !== false && handles === name) {
    throw new Error(`media and metadata cannot share the IndexedDB database ${name}`);
  }
  return {
    ...(name === false ? {} : { meta: await deps.metadata?.(name) }),
    ...(handles === false ? {} : { media: await deps.media?.(handles) }),
  };
}

function cdpOption(req: InitRequest, port: KernelPort): { cdp?: CdpHook } {
  if (!req.cdp) return {};
  return {
    cdp: portCdpHook((request, cdp) =>
      port.postMessage({ cdpOpen: request, port: cdp }, [cdp as unknown as MessagePort])
    ),
  };
}

function remotes(
  port: KernelPort,
  req: InitRequest
): { transport?: RemoteTransport; uplink?: RemoteUplink } {
  return {
    ...(req.transport ? { transport: new RemoteTransport(port, req.transport) } : {}),
    ...(req.uplink ? { uplink: new RemoteUplink(port, req.uplink.traits, req.uplink.routes) } : {}),
  };
}

function dial(l: Launcher, req: DialRequest): MessagePort {
  const socket = dialSocket(l.net, req.port, req.host);
  const { port1, port2 } = new MessageChannel();
  serveSocket(socket, port1);
  return port2;
}

interface SudoApprovals {
  ask: ApproveHook;
  answer(reply: { id: string; answer: SudoAnswer }): void;
}

function sudoApprovals(port: KernelPort): SudoApprovals {
  const waiting = new Map<string, (answer: SudoAnswer) => void>();
  return {
    ask: (req, { signal }) =>
      new Promise<SudoAnswer>((resolve) => {
        waiting.set(req.id, resolve);
        signal.addEventListener(
          'abort',
          () => {
            waiting.delete(req.id);
            port.postMessage({ sudoAbort: { id: req.id, reason: String(signal.reason) } });
            resolve('deny');
          },
          { once: true }
        );
        port.postMessage({ sudoAsk: req });
      }),
    answer({ id, answer }) {
      waiting.get(id)?.(answer);
      waiting.delete(id);
    },
  };
}

function answered(
  data: {
    net?: unknown;
    uplink?: unknown;
    sudoAnswer?: { id: string; answer: SudoAnswer };
  },
  remote: RemoteTransport | undefined,
  uplink: RemoteUplink | undefined,
  approvals: SudoApprovals
): boolean {
  if (data.sudoAnswer) approvals.answer(data.sudoAnswer);
  else if (data.net !== undefined) remote?.receive(data as TransportReply);
  else if (typeof data.uplink === 'string') uplink?.receive(data as UplinkReply);
  else return false;
  return true;
}

export interface GrantReply {
  id: number;
  grant?: HostfsGrant | HostfsPortGrant;
  error?: string;
}

const USERS_OPS: ReadonlySet<string> = new Set([
  'users-add',
  'users-remove',
  'users-list',
  'groups-list',
  'groups-add-member',
  'groups-remove-member',
]);

const ATTEST_OPS: ReadonlySet<string> = new Set([
  'attest',
  'watch-files',
  'unwatch-files',
  'chmod',
]);

function isAttestRequest(req: KernelRequest): req is AttestRequest {
  return ATTEST_OPS.has(req.op);
}

function isUsersRequest(req: KernelRequest): req is UsersRequest {
  return USERS_OPS.has(req.op);
}

function transferOf(req: KernelRequest, result: unknown): Transferable[] | undefined {
  if (result instanceof MessagePort) return [result];
  if (req.op === 'attest') return [(result as Attestation).bytes.buffer as ArrayBuffer];
  return undefined;
}

function attestOps(port: KernelPort) {
  const watches = new Map<number, () => void>();
  return async (l: Launcher, req: AttestRequest): Promise<unknown> => {
    if (req.op === 'attest') return l.attest(req.path);
    if (req.op === 'chmod') return l.fs.chmod(req.path, modeOption(req.mode)).then(() => true);
    if (req.op === 'unwatch-files') {
      watches.get(req.watch)?.();
      return watches.delete(req.watch);
    }
    const notify = (path: string) => port.postMessage({ fileChanged: { watch: req.id, path } });
    watches.set(req.id, await l.watchFiles(req.paths, notify));
    return req.id;
  };
}

function failure(err: unknown): { error: string; code?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return {
    error: err instanceof Error ? err.message : String(err),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

function usersOp(l: Launcher, req: UsersRequest): Promise<unknown> {
  if (req.op === 'users-add') return l.users.add(req.user);
  if (req.op === 'users-remove') return l.users.remove(req.name, req.options);
  if (req.op === 'groups-list') return l.users.groups();
  if (req.op === 'groups-add-member') return l.users.addMember(req.group, req.user);
  if (req.op === 'groups-remove-member') return l.users.removeMember(req.group, req.user);
  return l.users.list();
}

function hostOptions(
  req: InitRequest,
  port: KernelPort,
  sealed: SealedHook,
  clipboard: ClipboardHook,
  lookup: IntegrityLookup
): {
  hostname?: string;
  users?: UsersMode;
  onDenial?: DenialHook;
  sealed?: SealedHook;
  clipboard?: ClipboardHook;
  protect?: Protection;
} {
  return {
    ...(req.hostname !== undefined ? { hostname: req.hostname } : {}),
    ...(req.users !== undefined ? { users: req.users } : {}),
    ...(req.denials ? { onDenial: (denial: Denial) => port.postMessage({ denial }) } : {}),
    ...(req.protect ? { protect: hostProtect(req.protect, lookup) } : {}),
    ...(req.sealed ? { sealed } : {}),
    ...(req.clipboard ? { clipboard } : {}),
  };
}

function hostProtect(init: ProtectInit, lookup: IntegrityLookup): Protection {
  const { integrity, ...rest } = protectInit(init);
  return { ...rest, ...(integrity ? { integrity: { ...integrity, lookup } } : {}) };
}

function policyAsker(port: KernelPort) {
  const policies = new Map<number, (allowed: boolean) => void>();
  let nextPolicy = 0;
  const askPolicy = (req: ProcessMountRequest) =>
    new Promise<boolean>((resolve) => {
      const id = ++nextPolicy;
      policies.set(id, resolve);
      port.postMessage({ mountPolicy: { id, req } });
    });
  return {
    mountPolicy: (policy: InitRequest['processMounts']) =>
      policy === undefined ? {} : { processMounts: policy === 'ask' ? askPolicy : policy },
    allowed(data: unknown): boolean {
      const answer = (data as { mountAllowed?: { id: number; allowed: boolean } }).mountAllowed;
      if (!answer) return false;
      policies.get(answer.id)?.(answer.allowed);
      policies.delete(answer.id);
      return true;
    },
  };
}

export function serveKernel(port: KernelPort, deps: ServeDeps): void {
  let launcher: Promise<Launcher> | undefined;
  let remote: RemoteTransport | undefined;
  let uplink: RemoteUplink | undefined;
  const terminals = new Map<number, TerminalSession>();
  const reply = (id: number, body: object, transfer?: Transferable[]) =>
    port.postMessage({ id, ...body }, transfer);
  const clients = new Set<ServedClient>();
  const sealed = sealedAsker(port);
  const clipboard = clipboardAsker(port);
  const integrity = integrityAsker(port);
  const approvals = sudoApprovals(port);
  const locks = deps.locks === null ? undefined : (deps.locks ?? locksOf());
  let holding: Promise<string> | undefined;

  function holdLock(locks: LockManagerLike): Promise<string> {
    holding ??= new Promise<string>((resolve) => {
      const name = `slicc-kernel:${crypto.randomUUID()}`;
      void locks.request(name, () => {
        resolve(name);
        return new Promise(() => {});
      });
    });
    return holding;
  }

  async function connect(user: string | number | undefined, tag?: string): Promise<MessagePort> {
    const l = await ready();
    tagOption(tag);
    if (user !== undefined && !(await l.users.lookup(user))) {
      throw fsError('ENOENT', `no user ${String(user)}`);
    }
    const { port1, port2 } = new MessageChannel();
    const held = locks ? await holdLock(locks) : undefined;
    const served = serveClient(port1, {
      launcher: ready,
      signal: signalNumber,
      ...(user !== undefined ? { user } : {}),
      ...(tag !== undefined ? { tag } : {}),
      ...(locks ? { locks } : {}),
      ...(held ? { lock: held } : {}),
    });
    clients.add(served);
    void served.closed.then(() => clients.delete(served));
    return port2;
  }

  async function ready(): Promise<Launcher> {
    if (!launcher) throw new Error('the kernel is not initialized');
    return launcher;
  }

  async function terminal(
    req: OpenTerminalRequest
  ): Promise<number | { status: number; signal: number }> {
    const onData = (bytes: Uint8Array) => reply(req.id, { fd: 1, bytes });
    const session = await (await ready()).openTerminal(req.argv, { ...req.options, onData });
    terminals.set(req.id, session);
    reply(req.id, { started: session.pid });
    try {
      const status = await session.exited;
      const signal = session.termsig();
      return signal ? { status, signal } : status;
    } finally {
      terminals.delete(req.id);
    }
  }

  async function init(req: InitRequest): Promise<boolean> {
    launcher = (req.root ? Promise.resolve(req.root) : deps.storage()).then(async (root) => {
      const name = req.metadata ?? META_DB;
      const { meta, media } = await stores(deps, name, req.media);
      const net = remotes(port, req);
      ({ transport: remote, uplink } = net);
      const ranged = await inOpfs(deps, root);
      const fs = new OpfsFs(root, meta, dirsChannel(name), { ranged });
      await fs.reconcile();
      const started = new Launcher({
        fs,
        createWorker: deps.createWorker,
        ...(deps.createDriverWorker ? { createDriverWorker: deps.createDriverWorker } : {}),
        ...(req.modules ? { modules: req.modules } : {}),
        ...(req.commands ? { commands: req.commands } : {}),
        ...(req.env ? { env: req.env } : {}),
        ...hostOptions(req, port, sealed.hook, clipboard.hook, integrity.lookup),
        ...(req.approve ? { approve: approvals.ask } : {}),
        ...net,
        ...(media ? { media } : {}),
        onMountPending: (medium) => port.postMessage({ medium }),
        ...(req.hostfs ? { hostfs: askGrant } : {}),
        ...cdpOption(req, port),
        ...mountPolicy(req.processMounts),
        caStore: caStore(deps.metadata ? caDb(req) : false),
      });
      await started.prepare();
      return started;
    });
    await launcher;
    return true;
  }

  async function mountOp(req: MountRequest): Promise<unknown> {
    const l = await ready();
    if (req.op === 'mount') return l.mount(req.spec);
    if (req.op === 'umount') return l.umount(req.target);
    if (req.op === 'insert') return l.insert(req.target, req.handle, req.source);
    return l.mounts.list();
  }

  const attestOp = attestOps(port);

  async function handle(req: KernelRequest): Promise<unknown> {
    if (req.op === 'init') return init(req);
    if (isAttestRequest(req)) return attestOp(await ready(), req);
    if (req.op === 'open-terminal') return terminal(req);
    if (req.op === 'connect') return connect(req.user, req.tag);
    if (isUsersRequest(req)) return usersOp(await ready(), req);
    if (req.op === 'routes' || req.op === 'transport-traits') {
      return networkOp(await ready(), req, remote);
    }
    if (req.op === 'dial') return dial(await ready(), req);
    if (req.op === 'mount' || req.op === 'umount' || req.op === 'mounts' || req.op === 'insert')
      return mountOp(req);
    if (req.op === 'terminal') {
      const session = terminals.get(req.terminal);
      if (!session) throw new Error(`no terminal ${req.terminal}`);
      act(session, req);
      return true;
    }
    return (await ready()).run(req.argv, {
      ...req.options,
      onStdout: (bytes) => reply(req.id, { fd: 1, bytes }),
      onStderr: (bytes) => reply(req.id, { fd: 2, bytes }),
    });
  }

  const grants = new Map<number, PromiseWithResolvers<HostfsGrant | HostfsPortGrant>>();
  let nextGrant = 0;
  const askGrant: HostfsGrantHook = (source, options) => {
    const id = ++nextGrant;
    const waiting = Promise.withResolvers<HostfsGrant | HostfsPortGrant>();
    grants.set(id, waiting);
    port.postMessage({ hostfs: { id, source, ...options } });
    return waiting.promise;
  };
  function granted({ id, grant, error }: GrantReply): void {
    const waiting = grants.get(id);
    if (!waiting) return;
    grants.delete(id);
    if (grant) waiting.resolve(grant);
    else waiting.reject(Object.assign(new Error(error ?? 'no grant'), { code: 'EACCES' }));
  }

  const { mountPolicy, allowed } = policyAsker(port);

  port.addEventListener('message', (event) => {
    const sealedReply = (event.data as { sealedReply?: SealedReply }).sealedReply;
    if (sealedReply) return sealed.answer(sealedReply);
    const clipboardReply = (event.data as { clipboardReply?: ClipboardReply }).clipboardReply;
    if (clipboardReply) return clipboard.answer(clipboardReply);
    const integrityReply = (event.data as { integrityReply?: IntegrityReply }).integrityReply;
    if (integrityReply) return integrity.answer(integrityReply);
    const grant = (event.data as { hostfsGrant?: GrantReply }).hostfsGrant;
    if (grant) return granted(grant);
    if (allowed(event.data)) return;
    if (answered(event.data, remote, uplink, approvals)) return;
    const req = event.data as KernelRequest;
    handle(req).then(
      (result) => reply(req.id, { result }, transferOf(req, result)),
      (err) => reply(req.id, failure(err))
    );
  });
}
