import { portCdpHook } from './cdp/port.ts';
import type { CdpHook } from './cdp/types.ts';
import { type LockManagerLike, locksOf } from './client/protocol.ts';
import { type ServedClient, serveClient } from './client/serve-client.ts';
import { META_DB, type MetaStore } from './fs/meta.ts';
import { OpfsFs } from './fs/opfs.ts';
import { dialSocket, serveSocket } from './kernel/dial.ts';
import type { WasmWorkerLike } from './kernel/host.ts';
import { CA_DB, caStore } from './kernel/net/network.ts';
import { RemoteTransport, type TransportReply } from './kernel/net/remote-transport.ts';
import type { RouteTable } from './kernel/net/routes.ts';
import type { RealmTransportTraits } from './kernel/net/transport.ts';
import { RemoteUplink, type UplinkReply, type UplinkTraits } from './kernel/net/uplink.ts';
import { SIG } from './kernel/signals.ts';
import {
  Launcher,
  type RunOptions,
  type TerminalOptions,
  type TerminalSession,
} from './launcher.ts';
import type { MediumHandle } from './mount/fsa.ts';
import type { HostfsGrant, HostfsGrantHook } from './mount/hostfs.ts';
import type { MediaStore } from './mount/media.ts';
import type { MountSpec } from './mount/mount-fs.ts';
import type { ProcessMountRequest } from './mount/syscall.ts';

export interface KernelPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

export interface InitRequest {
  id: number;
  op: 'init';
  root?: FileSystemDirectoryHandle;
  modules?: string;
  env?: Record<string, string>;
  metadata?: string | false;
  media?: string | false;
  ca?: string | false;
  transport?: RealmTransportTraits;
  uplink?: { traits: UplinkTraits; routes?: RouteTable };
  hostfs?: boolean;
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
}

export interface RoutesRequest {
  id: number;
  op: 'routes';
  routes: RouteTable;
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

export type KernelRequest =
  | InitRequest
  | RunRequest
  | OpenTerminalRequest
  | TerminalRequest
  | ConnectRequest
  | MountRequest
  | DialRequest
  | RoutesRequest;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export type KernelCall = WithoutId<KernelRequest>;

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

function answered(
  data: { net?: unknown; uplink?: unknown },
  remote: RemoteTransport | undefined,
  uplink: RemoteUplink | undefined
): boolean {
  if (data.net !== undefined) remote?.receive(data as TransportReply);
  else if (typeof data.uplink === 'string') uplink?.receive(data as UplinkReply);
  else return false;
  return true;
}

export interface GrantReply {
  id: number;
  grant?: HostfsGrant;
  error?: string;
}

export function serveKernel(port: KernelPort, deps: ServeDeps): void {
  let launcher: Promise<Launcher> | undefined;
  let remote: RemoteTransport | undefined;
  let uplink: RemoteUplink | undefined;
  const terminals = new Map<number, TerminalSession>();
  const reply = (id: number, body: object, transfer?: Transferable[]) =>
    port.postMessage({ id, ...body }, transfer);
  const clients = new Set<ServedClient>();

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

  async function connect(): Promise<MessagePort> {
    await ready();
    const { port1, port2 } = new MessageChannel();
    const held = locks ? await holdLock(locks) : undefined;
    const served = serveClient(port1, {
      launcher: ready,
      signal: signalNumber,
      ...(locks ? { locks } : {}),
      ...(held ? { lock: held } : {}),
    });
    clients.add(served);
    void served.closed.then(() => clients.delete(served));
    return port2;
  }

  async function dial(req: DialRequest): Promise<MessagePort> {
    const socket = dialSocket((await ready()).net, req.port, req.host);
    const { port1, port2 } = new MessageChannel();
    serveSocket(socket, port1);
    return port2;
  }

  async function ready(): Promise<Launcher> {
    if (!launcher) throw new Error('the kernel is not initialized');
    return launcher;
  }

  async function terminal(req: OpenTerminalRequest): Promise<number> {
    const onData = (bytes: Uint8Array) => reply(req.id, { fd: 1, bytes });
    const session = await (await ready()).openTerminal(req.argv, { ...req.options, onData });
    terminals.set(req.id, session);
    reply(req.id, { started: session.pid });
    try {
      return await session.exited;
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
        ...(req.env ? { env: req.env } : {}),
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

  async function handle(req: KernelRequest): Promise<unknown> {
    if (req.op === 'init') return init(req);
    if (req.op === 'open-terminal') return terminal(req);
    if (req.op === 'connect') return connect();
    if (req.op === 'routes') {
      (await ready()).setRoutes(req.routes);
      return true;
    }
    if (req.op === 'dial') return dial(req);
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

  const grants = new Map<number, PromiseWithResolvers<HostfsGrant>>();
  let nextGrant = 0;
  const askGrant: HostfsGrantHook = (source, options) => {
    const id = ++nextGrant;
    const waiting = Promise.withResolvers<HostfsGrant>();
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

  const policies = new Map<number, (allowed: boolean) => void>();
  let nextPolicy = 0;
  const askPolicy = (req: ProcessMountRequest) =>
    new Promise<boolean>((resolve) => {
      const id = ++nextPolicy;
      policies.set(id, resolve);
      port.postMessage({ mountPolicy: { id, req } });
    });

  const mountPolicy = (policy: InitRequest['processMounts']) =>
    policy === undefined ? {} : { processMounts: policy === 'ask' ? askPolicy : policy };

  port.addEventListener('message', (event) => {
    const grant = (event.data as { hostfsGrant?: GrantReply }).hostfsGrant;
    if (grant) return granted(grant);
    const answer = (event.data as { mountAllowed?: { id: number; allowed: boolean } }).mountAllowed;
    if (answer) {
      policies.get(answer.id)?.(answer.allowed);
      policies.delete(answer.id);
      return;
    }
    if (answered(event.data, remote, uplink)) return;
    const req = event.data as KernelRequest;
    handle(req).then(
      (result) => reply(req.id, { result }, result instanceof MessagePort ? [result] : undefined),
      (err) => reply(req.id, { error: err instanceof Error ? err.message : String(err) })
    );
  });
}
