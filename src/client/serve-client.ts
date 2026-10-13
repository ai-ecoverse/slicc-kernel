import { fresh } from '../bytes.ts';
import { portCdpHook } from '../cdp/port.ts';
import { access, R_OK, X_OK } from '../fs/access.ts';
import {
  type Guard,
  inParent,
  listable,
  makeIn,
  readable,
  removable,
  renamable,
  searchable,
  writable,
} from '../fs/dac.ts';
import { fsError, type KernelFs, type NewOwner, type Owner } from '../fs/types.ts';
import { parentOf } from '../fs/walk.ts';
import type { WatchChange } from '../fs/watch.ts';
import { type Cred, copyCred, ROOT } from '../kernel/cred.ts';
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
  tag?: string;
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

type ClientCheck = (g: Guard, at: (i: number) => string) => Promise<unknown>;

const CLIENT_CHECKS: Readonly<Record<string, ClientCheck>> = {
  readFile: (g, at) => readable(g, 'read', at(0)),
  writeFile: (g, at) => writable(g, 'write', at(0)),
  stat: (g, at) => searchable(g, 'stat', at(0), true),
  lstat: (g, at) => searchable(g, 'lstat', at(0), false),
  readdir: (g, at) => listable(g, 'readdir', at(0)),
  mkdir: (g, at) => makeIn(g, 'mkdir', at(0)),
  rm: (g, at) => removable(g, 'rm', at(0)),
  rename: (g, at) => renamable(g, at(0), at(1)),
  realpath: (g, at) => searchable(g, 'realpath', at(0), true),
  symlink: (g, at) => inParent(g, 'symlink', at(1)),
  readlink: (g, at) => searchable(g, 'readlink', at(0), false),
  exists: (g, at) => searchable(g, 'exists', at(0), true),
};

async function fsCall(
  fs: KernelFs,
  method: string,
  args: unknown[],
  owner?: Owner & { umask: number },
  g?: Guard
): Promise<Answer> {
  const path = (i: number) => fs.resolvePath('/', String(args[i]));
  if (g) {
    const denied = await Promise.resolve((CLIENT_CHECKS[method] as ClientCheck)(g, path)).then(
      () => false,
      (err: unknown) => {
        if (method === 'exists') return true;
        throw err;
      }
    );
    if (denied) return { result: false };
  }
  switch (method) {
    case 'readFile': {
      const bytes = fresh(await fs.readFileBuffer(path(0)));
      return { result: bytes, transfer: [bytes.buffer] };
    }
    case 'writeFile':
      await fs.writeFile(path(0), args[1] as Uint8Array | string, created(owner, 0o666));
      return { result: true };
    case 'stat':
      return { result: await fs.stat(path(0)) };
    case 'lstat':
      return { result: await fs.lstat(path(0)) };
    case 'readdir':
      return { result: await fs.readdir(path(0)) };
    case 'mkdir':
      await fs.mkdir(
        path(0),
        owner ? { recursive: true, owner: made(owner) } : { recursive: true }
      );
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
      await fs.symlink(String(args[0]), path(1), owner && { uid: owner.uid, gid: owner.gid });
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

function created(owner: (Owner & { umask: number }) | undefined, mode: number) {
  return owner && { uid: owner.uid, gid: owner.gid, mode: mode & ~owner.umask };
}

function made(owner: Owner & { umask: number }): NewOwner {
  const mode = 0o777 & ~owner.umask;
  return { uid: owner.uid, gid: owner.gid, mode, parents: mode | 0o300 };
}

function ownerFor(l: Launcher, self: Account | undefined): (Owner & { umask: number }) | undefined {
  if (!l.owners || !self) return undefined;
  return { uid: self.uid, gid: self.gid, umask: self.umask ?? 0o022 };
}

function guardFor(l: Launcher, self: Account | undefined, tag?: string): Guard | undefined {
  if (!l.dac || !self) return undefined;
  return { fs: l.fs, cred: credOf(self), pid: 0, dac: l.dac, tag };
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

function clientCred(self: Account | undefined): Cred {
  return self ? credOf(self) : copyCred(ROOT);
}

async function runTagged(
  l: Launcher,
  self: Account,
  requested: string | number | undefined,
  tag: string | undefined
): Promise<{ user: Account; tag: string | undefined }> {
  return { user: await runAs(l, self, requested), tag };
}

function processes(l: Launcher, self: Account): ProcessEntry[] {
  const viewer = credOf(self);
  return l.list(viewer).map(({ tid: _, cred = viewer, umask: _umask, ...entry }) => ({
    ...entry,
    rss: entry.memory,
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

function visibleTo(g: Guard | undefined, notify: (change: WatchChange) => void) {
  if (!g?.dac.enforcing) return notify;
  let queue = Promise.resolve();
  const seen = async (path: string) =>
    (await access(g.fs, g.cred, parentOf(path), R_OK | X_OK, { directory: true })).denied ===
    undefined;
  return (change: WatchChange) => {
    queue = queue.then(async () => {
      if (!('paths' in change)) return notify(change);
      const paths: string[] = [];
      for (const path of change.paths) if (await seen(path)) paths.push(path);
      if (paths.length > 0) notify({ paths });
    });
  };
}

async function watchOp(
  l: Launcher,
  req: Extract<ClientRequest, { op: 'watch' | 'unwatch' }>,
  watches: Map<number, () => void>,
  send: (message: object) => void,
  g?: Guard
): Promise<Answer> {
  if (req.op === 'unwatch') {
    watches.get(req.watch)?.();
    watches.delete(req.watch);
    return { result: true };
  }
  if (g) for (const path of req.paths) await readable(g, 'watch', l.fs.resolvePath('/', path));
  const notify = visibleTo(g, (change) => send({ watch: req.id, change }));
  const unwatch = l.watchers.watch(req.paths, { recursive: req.recursive }, notify);
  watches.set(req.id, unwatch);
  return { result: req.id };
}

export function serveClient(port: MessagePortLike, host: ClientHost): ServedClient {
  let state: 'new' | 'open' | 'closed' = 'new';
  let self: Account | undefined;
  const guard = (l: Launcher) => guardFor(l, self, host.tag);
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
        ...(launcher.usersMode ? { users: launcher.usersMode } : {}),
        ...(host.lock ? { lock: host.lock } : {}),
      },
    });
  }

  async function terminal(req: Extract<ClientRequest, { op: 'open-terminal' }>, l: Launcher) {
    const session = await l.openTerminal(req.argv, {
      ...req.options,
      ...(await runTagged(l, self as Account, req.options.user, host.tag)),
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
      ...(await runTagged(l, self as Account, req.options.user, host.tag)),
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
        return fsCall(l.processFs, req.method, req.args, ownerFor(l, self), guard(l));
      case 'watch':
      case 'unwatch':
        return watchOp(l, req, watches, send, guard(l));
      case 'mount':
        return { result: await l.mountAs(clientCred(self), req.spec) };
      case 'umount':
        await l.umountAs(clientCred(self), req.target);
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
