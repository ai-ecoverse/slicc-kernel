import { type LockManagerLike, locksOf } from './client/protocol.ts';
import { type ServedClient, serveClient } from './client/serve-client.ts';
import { META_DB, type MetaStore } from './fs/meta.ts';
import { OpfsFs } from './fs/opfs.ts';
import type { WasmWorkerLike } from './kernel/host.ts';
import { caStore } from './kernel/net/network.ts';
import { RemoteTransport, type TransportReply } from './kernel/net/remote-transport.ts';
import type { RealmTransportTraits } from './kernel/net/transport.ts';
import { SIG } from './kernel/signals.ts';
import {
  Launcher,
  type RunOptions,
  type TerminalOptions,
  type TerminalSession,
} from './launcher.ts';
import type { MediumHandle } from './mount/fsa.ts';
import type { MediaStore } from './mount/media.ts';
import type { MountSpec } from './mount/mount-fs.ts';

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
  transport?: RealmTransportTraits;
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

export type MountRequest =
  | { id: number; op: 'mount'; spec: MountSpec }
  | { id: number; op: 'umount'; target: string }
  | { id: number; op: 'mounts' }
  | { id: number; op: 'insert'; target: string; handle: MediumHandle };

export type KernelRequest =
  | InitRequest
  | RunRequest
  | OpenTerminalRequest
  | TerminalRequest
  | ConnectRequest
  | MountRequest;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export type KernelCall = WithoutId<KernelRequest>;

export interface ServeDeps {
  storage: () => Promise<FileSystemDirectoryHandle>;
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

async function stores(
  deps: ServeDeps,
  name: string | false
): Promise<{ meta?: MetaStore | undefined; media?: MediaStore | undefined }> {
  if (name === false) return {};
  return { meta: await deps.metadata?.(name), media: await deps.media?.(`${name}:media`) };
}

export function serveKernel(port: KernelPort, deps: ServeDeps): void {
  let launcher: Promise<Launcher> | undefined;
  let remote: RemoteTransport | undefined;
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
      const { meta, media } = await stores(deps, name);
      remote = req.transport ? new RemoteTransport(port, req.transport) : undefined;
      const fs = new OpfsFs(root, meta, dirsChannel(name));
      await fs.reconcile();
      const started = new Launcher({
        fs,
        createWorker: deps.createWorker,
        ...(deps.createDriverWorker ? { createDriverWorker: deps.createDriverWorker } : {}),
        ...(req.modules ? { modules: req.modules } : {}),
        ...(req.env ? { env: req.env } : {}),
        ...(remote ? { transport: remote } : {}),
        ...(media ? { media } : {}),
        onMountPending: (medium) => port.postMessage({ medium }),
        caStore: caStore(deps.metadata ? name : false),
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
    if (req.op === 'insert') return l.insert(req.target, req.handle);
    return l.mounts.list();
  }

  async function handle(req: KernelRequest): Promise<unknown> {
    if (req.op === 'init') return init(req);
    if (req.op === 'open-terminal') return terminal(req);
    if (req.op === 'connect') return connect();
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

  port.addEventListener('message', (event) => {
    if ((event.data as { net?: unknown }).net !== undefined) {
      remote?.receive(event.data as TransportReply);
      return;
    }
    const req = event.data as KernelRequest;
    handle(req).then(
      (result) => reply(req.id, { result }, result instanceof MessagePort ? [result] : undefined),
      (err) => reply(req.id, { error: err instanceof Error ? err.message : String(err) })
    );
  });
}
