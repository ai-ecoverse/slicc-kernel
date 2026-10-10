import { portCdpHook } from '../cdp/port.ts';
import { fsError, type KernelFs } from '../fs/types.ts';
import { dialSocket, serveSocket } from '../kernel/dial.ts';
import type { TransportCall } from '../kernel/net/remote-transport.ts';
import type { RealmTransport } from '../kernel/net/transport.ts';
import { SIG } from '../kernel/signals.ts';
import type { Launcher, TerminalSession } from '../launcher.ts';
import { serveTransport, type TransportServer } from '../transport.ts';
import { type Account, credOf } from '../users.ts';
import {
  type ClientHello,
  type ClientRequest,
  FS_METHODS,
  type LockManagerLike,
  type MessagePortLike,
  PROTOCOL,
  type ProcessEntry,
  type TerminalAction,
  versionError,
} from './protocol.ts';

export interface ClientHost {
  scope?: 'transport';
  launcher: () => Promise<Launcher>;
  transport?: () => RealmTransport;
  locks?: LockManagerLike;
  lock?: string;
  signal?: (name: string) => number;
  user?: string | number;
}

export interface ServedClient {
  detach(kill?: boolean): void;
  readonly closed: Promise<void>;
}

interface Answer {
  result: unknown;
  transfer?: Transferable[];
}

const MAX_LINKS = 40;

function act(session: TerminalSession, req: TerminalAction, signal: (name: string) => number) {
  if (req.action === 'write') session.write(req.bytes);
  else if (req.action === 'resize') session.resize(req.cols, req.rows);
  else if (req.action === 'signal') session.signal(signal(req.signal));
  else session.close();
}

async function realpath(fs: KernelFs, path: string): Promise<string> {
  let parts = fs.resolvePath('/', path).split('/').filter(Boolean);
  let resolved = '';
  for (let hops = 0; parts.length > 0; ) {
    const [name, ...rest] = parts;
    const next = `${resolved}/${name}`;
    if (!(await fs.lstat(next)).isSymbolicLink) {
      resolved = next;
      parts = rest;
      continue;
    }
    if (++hops > MAX_LINKS) throw fsError('ELOOP', path);
    const target = await fs.readlink(next);
    const base = target.startsWith('/') ? '/' : resolved || '/';
    parts = [...fs.resolvePath(base, target).split('/').filter(Boolean), ...rest];
    resolved = '';
  }
  return resolved || '/';
}

async function fsCall(fs: KernelFs, method: string, args: unknown[]): Promise<Answer> {
  const path = (i: number) => fs.resolvePath('/', String(args[i]));
  switch (method) {
    case 'readFile': {
      const bytes = (await fs.readFileBuffer(path(0))).slice();
      return { result: bytes, transfer: [bytes.buffer] };
    }
    case 'writeFile':
      await fs.writeFile(path(0), args[1] as Uint8Array | string);
      return { result: true };
    case 'stat':
      return { result: await fs.stat(path(0)) };
    case 'lstat':
      return { result: await fs.lstat(path(0)) };
    case 'readdir':
      return { result: await fs.readdir(path(0)) };
    case 'mkdir':
      await fs.mkdir(path(0), { recursive: true });
      return { result: true };
    case 'rm':
      await fs.rm(path(0), { recursive: true, force: args[1] === true });
      return { result: true };
    case 'rename':
      await fs.rename(path(0), path(1));
      return { result: true };
    case 'realpath':
      return { result: await realpath(fs, String(args[0])) };
    case 'symlink':
      await fs.symlink(String(args[0]), path(1));
      return { result: true };
    case 'readlink':
      return { result: await fs.readlink(path(0)) };
    default:
      return { result: await fs.exists(path(0)) };
  }
}

function signalOf(host: ClientHost): (name: string) => number {
  return (
    host.signal ??
    ((name) => {
      throw fsError('EINVAL', `this kernel names no signal ${name}`);
    })
  );
}

function dialFor(
  l: Launcher,
  req: Extract<ClientRequest, { op: 'dial' }>,
  open: Map<number, () => void>
): Answer {
  const socket = dialSocket(l.net, req.port, req.host);
  const { port1, port2 } = new MessageChannel();
  open.set(
    req.id,
    serveSocket(socket, port1, () => open.delete(req.id))
  );
  return { result: port2, transfer: [port2] };
}

async function accountOf(l: Launcher, user: string | number): Promise<Account> {
  const found = await l.users.lookup(user);
  if (!found) throw fsError('ENOENT', `no user ${String(user)}`);
  return found;
}

async function runAs(l: Launcher, self: Account, requested?: string | number): Promise<Account> {
  if (requested === undefined) return self;
  const target = await accountOf(l, requested);
  if (self.uid !== 0 && target.uid !== self.uid) {
    throw fsError('EPERM', `${self.name} may not run as ${target.name}`);
  }
  return target;
}

function processes(l: Launcher, self: Account): ProcessEntry[] {
  const viewer = credOf(self);
  return l.list(viewer).map(({ tid: _, cred = viewer, umask: _umask, ...entry }) => ({
    ...entry,
    uid: cred.euid,
    gid: cred.egid,
  }));
}

function killAs(
  l: Launcher,
  host: ClientHost,
  self: Account,
  req: Extract<ClientRequest, { op: 'kill' }>
): Answer {
  if (!l.kill(req.pid, signalOf(host)(req.signal), credOf(self))) {
    throw fsError('ESRCH', `pid ${req.pid}`);
  }
  return { result: true };
}

function terminalAction(
  terminals: Map<number, TerminalSession>,
  req: Extract<ClientRequest, { op: 'terminal' }>,
  host: ClientHost
): Answer {
  const session = terminals.get(req.terminal);
  if (!session) throw new Error(`no terminal ${req.terminal}`);
  act(session, req, signalOf(host));
  return { result: true };
}

function killGroups(host: ClientHost, pgids: number[]): void {
  if (pgids.length === 0) return;
  void host.launcher().then((launcher) => {
    for (const pgid of pgids) launcher.kill(-pgid, SIG.KILL);
  });
}

function joinable(l: Launcher, pgid: number, ours: (sid: number) => boolean): void {
  const sid = l.groupSession(pgid);
  if (sid === undefined) throw fsError('ESRCH', `no process group ${pgid}`);
  if (!ours(sid)) throw fsError('EPERM', `process group ${pgid} is in another session`);
}

function cdpRegistry(
  send: (message: object, transfer: Transferable[]) => void,
  gone: Promise<void>
) {
  const registered = new Map<number, () => void>();
  const drop = (id: number) => {
    registered.get(id)?.();
    return registered.delete(id);
  };
  return {
    serve(l: Launcher, req: Extract<ClientRequest, { op: 'serve-cdp' }>): number {
      const hook = portCdpHook(
        (request, cdp) =>
          send({ cdpOpen: { ...request, registration: req.id }, port: cdp }, [
            cdp as unknown as Transferable,
          ]),
        gone
      );
      registered.set(req.id, l.cdp.register(hook, req.runtime));
      return req.id;
    },
    drop,
    close: () => {
      for (const id of [...registered.keys()]) drop(id);
    },
  };
}

function watchOp(
  l: Launcher,
  req: Extract<ClientRequest, { op: 'watch' | 'unwatch' }>,
  watches: Map<number, () => void>,
  send: (message: object) => void
): Answer {
  if (req.op === 'unwatch') {
    watches.get(req.watch)?.();
    watches.delete(req.watch);
    return { result: true };
  }
  const unwatch = l.watchers.watch(req.paths, { recursive: req.recursive }, (change) =>
    send({ watch: req.id, change })
  );
  watches.set(req.id, unwatch);
  return { result: req.id };
}

export function serveClient(port: MessagePortLike, host: ClientHost): ServedClient {
  let state: 'new' | 'open' | 'closed' = 'new';
  let self: Account | undefined;
  const terminals = new Map<number, TerminalSession>();
  const groups = new Set<number>();
  const sessions = new Set<number>();
  const watches = new Map<number, () => void>();
  let net: TransportServer | undefined;
  const ended = Promise.withResolvers<void>();
  const send = (message: object, transfer: Transferable[] = []) => {
    if (state !== 'closed') port.postMessage(message, transfer);
  };
  const reply = (id: number, body: object, transfer?: Transferable[]) =>
    send({ id, ...body }, transfer);
  const cdps = cdpRegistry(send, ended.promise);

  function detach(kill = false, bye = 'the slicc-kernel detached this client'): void {
    if (state === 'closed') return;
    send({ bye });
    state = 'closed';
    net?.close();
    for (const unwatch of watches.values()) unwatch();
    watches.clear();
    cdps.close();
    for (const session of terminals.values()) session.close();
    terminals.clear();
    if (kill) killGroups(host, [...groups]);
    groups.clear();
    port.close?.();
    ended.resolve();
  }

  async function hello(message: ClientHello): Promise<void> {
    const refused = versionError(message.protocol);
    if (refused) {
      send({ hello: { protocol: PROTOCOL, error: refused } });
      detach();
      return;
    }
    const launcher = await host.launcher();
    if (host.scope !== 'transport') self = await accountOf(launcher, host.user ?? 0);
    const transport = host.transport?.() ?? launcher.transport;
    net = serveTransport({ postMessage: (m, t) => send(m, t) }, transport);
    state = 'open';
    if (message.lock && host.locks) void host.locks.request(message.lock, () => detach());
    send({
      hello: {
        protocol: PROTOCOL,
        traits: transport.traits,
        ...(host.lock ? { lock: host.lock } : {}),
      },
    });
  }

  async function terminal(req: Extract<ClientRequest, { op: 'open-terminal' }>, l: Launcher) {
    const session = await l.openTerminal(req.argv, {
      ...req.options,
      user: await runAs(l, self as Account, req.options.user),
      onData: (bytes) => reply(req.id, { fd: 1, bytes: bytes.slice() }),
    });
    if (state === 'closed') {
      session.close();
    } else {
      terminals.set(req.id, session);
      sessions.add(session.pid);
      reply(req.id, { started: session.pid });
    }
    try {
      return { result: await session.exited };
    } finally {
      terminals.delete(req.id);
    }
  }

  async function spawn(req: Extract<ClientRequest, { op: 'spawn' }>, l: Launcher) {
    const out = (fd: 1 | 2) => (bytes: Uint8Array) => reply(req.id, { fd, bytes: bytes.slice() });
    if (req.options.pgid !== undefined) joinable(l, req.options.pgid, (sid) => sessions.has(sid));
    let leader: number | undefined;
    const result = await l.run(req.argv, {
      ...req.options,
      user: await runAs(l, self as Account, req.options.user),
      collect: false,
      onStdout: out(1),
      onStderr: out(2),
      onStarted: (pid) => {
        leader = pid;
        if (state === 'closed') return;
        groups.add(req.options.pgid ?? pid);
        if (req.options.pgid === undefined) sessions.add(pid);
        reply(req.id, { started: pid });
      },
    });
    if (leader === undefined) throw fsError('ENOENT', `${req.argv[0] ?? ''}: command not found`);
    if (!l.list().some((p) => p.pgid === leader)) groups.delete(leader);
    return { result: result.status };
  }

  async function handle(req: ClientRequest): Promise<Answer> {
    if (host.scope === 'transport' && req.op !== 'detach') {
      throw fsError('EPERM', `${req.op}: this client may only use the network transport`);
    }
    const l = await host.launcher();
    switch (req.op) {
      case 'spawn':
        return spawn(req, l);
      case 'open-terminal':
        return terminal(req, l);
      case 'terminal':
        return terminalAction(terminals, req, host);
      case 'kill':
        return killAs(l, host, self as Account, req);
      case 'ps':
        return { result: processes(l, self as Account) };
      case 'fs':
        if (!(FS_METHODS as readonly string[]).includes(req.method)) {
          throw new Error(`unknown file system call ${req.method}`);
        }
        return fsCall(l.fs, req.method, req.args);
      case 'watch':
      case 'unwatch':
        return watchOp(l, req, watches, send);
      case 'mount':
        return { result: await l.mount(req.spec) };
      case 'umount':
        l.umount(req.target);
        return { result: true };
      case 'mounts':
        return { result: l.mounts.list() };
      case 'dial':
        return dialFor(l, req, watches);
      case 'serve-cdp':
        return { result: cdps.serve(l, req) };
      case 'unserve-cdp':
        return { result: cdps.drop(req.registration) };
      case 'detach':
        return { result: true };
      default:
        throw new Error(`unknown op ${(req as { op: string }).op}`);
    }
  }

  port.addEventListener('message', (event) => {
    const data = event.data as { hello?: ClientHello; net?: unknown };
    if (state === 'closed') return;
    if (data.hello) {
      if (state === 'new') {
        hello(data.hello).catch((err: unknown) => {
          send({ hello: { protocol: PROTOCOL, error: String((err as Error)?.message ?? err) } });
          detach();
        });
      }
      return;
    }
    if (state !== 'open') return;
    if (data.net !== undefined) {
      net?.answer(data as TransportCall);
      return;
    }
    const req = data as ClientRequest;
    handle(req).then(
      ({ result, transfer }) => {
        reply(req.id, { result }, transfer);
        if (req.op === 'detach') detach(req.kill === true);
      },
      (err: unknown) => {
        const code = (err as { code?: unknown })?.code;
        reply(req.id, {
          error: err instanceof Error ? err.message : String(err),
          ...(typeof code === 'string' ? { code } : {}),
        });
      }
    );
  });
  port.addEventListener('close', () => detach());
  port.start?.();
  return { detach, closed: ended.promise };
}
