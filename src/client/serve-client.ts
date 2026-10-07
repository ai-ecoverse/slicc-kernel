import { fsError, type KernelFs } from '../fs/types.ts';
import type { TransportCall } from '../kernel/net/remote-transport.ts';
import type { RealmTransport } from '../kernel/net/transport.ts';
import { SIG } from '../kernel/signals.ts';
import type { Launcher, TerminalSession } from '../launcher.ts';
import { serveTransport, type TransportServer } from '../transport.ts';
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
  launcher: () => Promise<Launcher>;
  transport?: () => RealmTransport;
  locks?: LockManagerLike;
  lock?: string;
  signal: (name: string) => number;
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

export function serveClient(port: MessagePortLike, host: ClientHost): ServedClient {
  let state: 'new' | 'open' | 'closed' = 'new';
  const terminals = new Map<number, TerminalSession>();
  const groups = new Set<number>();
  const watches = new Map<number, () => void>();
  let net: TransportServer | undefined;
  const ended = Promise.withResolvers<void>();
  const send = (message: object, transfer: Transferable[] = []) => {
    if (state !== 'closed') port.postMessage(message, transfer);
  };
  const reply = (id: number, body: object, transfer?: Transferable[]) =>
    send({ id, ...body }, transfer);

  function detach(kill = false, bye = 'the slicc-kernel detached this client'): void {
    if (state === 'closed') return;
    send({ bye });
    state = 'closed';
    net?.close();
    for (const unwatch of watches.values()) unwatch();
    watches.clear();
    for (const session of terminals.values()) session.close();
    terminals.clear();
    const pids = [...groups];
    groups.clear();
    if (kill && pids.length > 0) {
      void host.launcher().then((launcher) => {
        for (const pid of pids) launcher.kill(-pid, SIG.KILL);
      });
    }
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
      onData: (bytes) => reply(req.id, { fd: 1, bytes: bytes.slice() }),
    });
    if (state === 'closed') {
      session.close();
    } else {
      terminals.set(req.id, session);
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
    let leader: number | undefined;
    const result = await l.run(req.argv, {
      ...req.options,
      collect: false,
      onStdout: out(1),
      onStderr: out(2),
      onStarted: (pid) => {
        leader = pid;
        if (state === 'closed') return;
        groups.add(pid);
        reply(req.id, { started: pid });
      },
    });
    if (leader === undefined) throw fsError('ENOENT', `${req.argv[0] ?? ''}: command not found`);
    if (!l.list().some((p) => p.pgid === leader)) groups.delete(leader);
    return { result: result.status };
  }

  async function handle(req: ClientRequest): Promise<Answer> {
    const l = await host.launcher();
    switch (req.op) {
      case 'spawn':
        return spawn(req, l);
      case 'open-terminal':
        return terminal(req, l);
      case 'terminal': {
        const session = terminals.get(req.terminal);
        if (!session) throw new Error(`no terminal ${req.terminal}`);
        act(session, req, host.signal);
        return { result: true };
      }
      case 'kill':
        if (!l.kill(req.pid, host.signal(req.signal))) throw fsError('ESRCH', `pid ${req.pid}`);
        return { result: true };
      case 'ps':
        return {
          result: l.list().map(({ tid: _, ...entry }): ProcessEntry => entry),
        };
      case 'fs':
        if (!(FS_METHODS as readonly string[]).includes(req.method)) {
          throw new Error(`unknown file system call ${req.method}`);
        }
        return fsCall(l.fs, req.method, req.args);
      case 'watch': {
        const unwatch = l.watchers.watch(req.paths, { recursive: req.recursive }, (change) =>
          send({ watch: req.id, change })
        );
        watches.set(req.id, unwatch);
        return { result: req.id };
      }
      case 'unwatch':
        watches.get(req.watch)?.();
        watches.delete(req.watch);
        return { result: true };
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
