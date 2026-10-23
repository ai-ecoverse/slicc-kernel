import { type FdTable, KernelError, type KernelFile, OpenFile } from '../fd-table.ts';
import type { KernelSocket } from '../socket.ts';
import type { TlsCipher } from './tls-ciphers.ts';
import {
  type ServerChoice,
  type ServerOffer,
  type TlsServerInfo,
  tlsServer,
} from './tls-client.ts';
import {
  TLS_KEYLOG,
  TLS_SERVER_REQUEST_CERT,
  TLS_SERVER_REQUIRE_CERT,
  TLS_SERVER_SELECT,
  type TlsEngine,
  type TlsLeaf,
  type TlsStore,
} from './tls-engine.ts';
import {
  base64Der,
  type ClientCert,
  type ClientCertRequest,
  certBytes,
  defaultStore,
  encode,
  encryptedKey,
  handshakeAbort,
  keyRefused,
  type SecureProcess,
  supportOf,
  wipe,
} from './tls-uplink.ts';

export interface ServeRequest {
  cert?: ClientCertRequest;
  ca?: string[];
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  alpn?: string[];
  handshakeTimeout?: number;
  select?: boolean;
  keylog?: boolean;
  listener?: KernelSocket;
}

export interface SelectRequest {
  context?: number;
  alpn?: string;
  refuse?: number;
}

const HANDSHAKE_TIMEOUT_MS = 120_000;

export interface ServedSession {
  path: 'kernel';
  protocol: 'TLSv1.2' | 'TLSv1.3';
  alpnProtocol: string | false;
  servername: string;
  authorized: boolean;
  authorizationError?: string;
  peerCertificates: string[];
  cipher: TlsCipher;
  keylog?: string[];
}

interface Server {
  engine: TlsEngine;
  leaf: TlsLeaf | undefined;
  store: TlsStore | undefined;
  alpn: string[];
  flags: number;
  timeoutMs: number;
  release(): void;
}

function leafOf(engine: TlsEngine, cert: ClientCert): TlsLeaf {
  try {
    return engine.importLeaf(cert.chain, cert.key, cert.pass);
  } catch (err) {
    throw keyRefused(err, cert.pass.length > 0 && encryptedKey(cert.key));
  } finally {
    wipe(cert);
  }
}

function storeOf(engine: TlsEngine, ca: readonly string[]): TlsStore {
  const store = engine.store();
  try {
    for (const der of ca) store.add(base64Der(der));
    return store;
  } catch (err) {
    store.release();
    throw new KernelError('EINVAL', `ERR_INVALID_ARG_VALUE: ca: ${(err as Error).message}`);
  }
}

function certFlags(req: ServeRequest): number {
  if (!req.requestCert) return 0;
  return req.rejectUnauthorized === false ? TLS_SERVER_REQUEST_CERT : TLS_SERVER_REQUIRE_CERT;
}

const CERT_FLAGS = TLS_SERVER_REQUEST_CERT | TLS_SERVER_REQUIRE_CERT;

function selectFlag(req: ServeRequest): number {
  if (!req.select) return 0;
  if (req.alpn && req.alpn.length > 0)
    throw new KernelError('EINVAL', 'ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS: alpn with select');
  return TLS_SERVER_SELECT;
}

function flagsOf(req: ServeRequest): number {
  return certFlags(req) | selectFlag(req) | (req.keylog ? TLS_KEYLOG : 0);
}

type Needs = { select?: boolean | undefined; keylog?: boolean | undefined };

async function engineOf(proc: SecureProcess, { select, keylog }: Needs): Promise<TlsEngine> {
  const engine = await supportOf(proc.net).engine();
  if (!engine.serverSessions)
    throw new KernelError('ENOTSUP', 'the installed tls engine has no server sessions');
  if (keylog && !engine.keylogs)
    throw new KernelError('ENOTSUP', 'the installed tls engine has no key log');
  if (select && !engine.serverSelect)
    throw new KernelError('ENOTSUP', 'the installed tls engine has no server selection');
  return engine;
}

async function importedLeaf(proc: SecureProcess, own: ClientCertRequest, needs: Needs = {}) {
  const cert = certBytes(own);
  let engine: TlsEngine;
  try {
    engine = await engineOf(proc, needs);
  } catch (err) {
    wipe(cert);
    throw err;
  }
  return { engine, leaf: leafOf(engine, cert) };
}

function timeoutOf(req: ServeRequest): number {
  const ms = req.handshakeTimeout ?? HANDSHAKE_TIMEOUT_MS;
  if (!Number.isInteger(ms) || ms <= 0)
    throw new KernelError(
      'EINVAL',
      'ERR_OUT_OF_RANGE: handshakeTimeout must be a positive integer'
    );
  return ms;
}

const timedOut = new KernelError('EPROTO', 'ERR_TLS_HANDSHAKE_TIMEOUT: TLS handshake timeout');

function handshakeSignal(proc: SecureProcess, ms: number) {
  const timer = new AbortController();
  const id = setTimeout(() => timer.abort(timedOut), ms);
  return {
    signal: AbortSignal.any([handshakeAbort(proc), timer.signal]),
    done: () => clearTimeout(id),
  };
}

export async function serverOf(proc: SecureProcess, req: ServeRequest): Promise<Server> {
  const own = req.cert;
  delete req.cert;
  if (!own && !req.select)
    throw new KernelError('EINVAL', 'ERR_INVALID_ARG_VALUE: a server needs cert and key');
  const { engine, leaf } = own
    ? await importedLeaf(proc, own, req)
    : { engine: await engineOf(proc, { ...req, select: true }), leaf: undefined };
  let mine: TlsStore | undefined;
  try {
    mine = req.ca && req.ca.length > 0 ? storeOf(engine, req.ca) : undefined;
    const flags = flagsOf(req);
    const store =
      mine ??
      (flags & CERT_FLAGS ? await defaultStore(engine, supportOf(proc.net).roots) : undefined);
    return {
      engine,
      leaf,
      store,
      alpn: req.alpn ?? [],
      flags,
      timeoutMs: timeoutOf(req),
      release() {
        leaf?.release();
        mine?.release();
      },
    };
  } catch (err) {
    leaf?.release();
    mine?.release();
    throw err;
  }
}

export async function listenSecure(
  proc: SecureProcess,
  socket: KernelSocket,
  req: ServeRequest
): Promise<void> {
  if (!socket.listening) throw new KernelError('EINVAL', 'not a listening socket');
  const server = await serverOf(proc, req);
  socket.serving?.release();
  socket.serving = server;
}

function servedOf(info: TlsServerInfo): ServedSession {
  return {
    path: 'kernel',
    protocol: info.protocol,
    alpnProtocol: info.alpnProtocol,
    servername: info.servername,
    authorized: info.authorized,
    ...(info.authorizationError ? { authorizationError: info.authorizationError } : {}),
    peerCertificates: info.peerCertificates.map(encode),
    cipher: info.cipher,
    ...(info.keylog ? { keylog: info.keylog } : {}),
  };
}

interface Pause {
  offer: ServerOffer;
  choose(choice: ServerChoice): void;
  fail(err: unknown): void;
}

interface Selecting {
  pause: Pause;
  run: Promise<TlsServerInfo>;
}

const selections = new WeakMap<KernelSocket, Selecting>();

function pausing(signal: AbortSignal) {
  let paused!: (pause: Pause) => void;
  const pausedAt = new Promise<Pause>((resolve) => {
    paused = resolve;
  });
  const select = (offer: ServerOffer) =>
    new Promise<ServerChoice>((choose, fail) => {
      if (signal.aborted) fail(signal.reason);
      signal.addEventListener('abort', () => fail(signal.reason), { once: true });
      paused({ offer, choose, fail });
    });
  return { pausedAt, select };
}

export async function serveSecure(
  proc: SecureProcess,
  socket: KernelSocket,
  req: ServeRequest
): Promise<ServedSession | { select: ServerOffer }> {
  const shared = req.listener?.serving as Server | undefined;
  if (req.listener && !shared) throw new KernelError('EINVAL', 'the listener has no tls');
  const server = shared ?? (await serverOf(proc, req));
  const { engine, leaf, alpn, store, flags } = server;
  const limit = handshakeSignal(proc, server.timeoutMs);
  const { pausedAt, select } = pausing(limit.signal);
  const certs = (flags & CERT_FLAGS) !== 0;
  const run = socket
    .secureLink(
      (raw) =>
        tlsServer(
          raw,
          engine.serverSession(leaf, alpn, store, flags),
          certs,
          flags & TLS_SERVER_SELECT ? select : undefined,
          (flags & TLS_KEYLOG) !== 0
        ),
      limit.signal,
      (reason) => !shared && reason === timedOut
    )
    .finally(() => {
      limit.done();
      selections.delete(socket);
      socket.pending = undefined;
      if (!shared) server.release();
    });
  run.catch(() => undefined);
  const first = await Promise.race([run, pausedAt.then((pause) => ({ pause }))]);
  if (!('pause' in first)) return servedOf(first);
  selections.set(socket, { pause: first.pause, run });
  socket.pending = () => first.pause.fail(new KernelError('ECONNRESET'));
  return { select: first.pause.offer };
}

const REFUSALS: ReadonlySet<number> = new Set([112, 120, 40, 49, 80]);

class TlsContext implements KernelFile {
  readonly leaf: TlsLeaf;
  constructor(leaf: TlsLeaf) {
    this.leaf = leaf;
  }
  close(): void {
    this.leaf.release();
  }
}

export const TLS_CONTEXTS_MAX = 64;

export async function contextSecure(
  proc: SecureProcess & { fds: FdTable },
  cert: ClientCertRequest | undefined
): Promise<number> {
  if (!cert) throw new KernelError('EINVAL', 'ERR_INVALID_ARG_VALUE: a context needs cert and key');
  const held = proc.fds.numbers().filter((fd) => proc.fds.get(fd).file instanceof TlsContext);
  if (held.length >= TLS_CONTEXTS_MAX) {
    wipe(certBytes(cert));
    throw new KernelError('EMFILE', `at most ${TLS_CONTEXTS_MAX} tls contexts per process`);
  }
  const { leaf } = await importedLeaf(proc, cert);
  const file = new OpenFile(new TlsContext(leaf));
  try {
    const fd = proc.fds.install(file, 3);
    proc.fds.setCloseOnExec(fd);
    return fd;
  } catch (err) {
    leaf.release();
    throw err;
  }
}

function contextAt(fds: FdTable, fd: number): { leaf: TlsLeaf; done: () => void } {
  const open = fds.get(fd);
  const file = open.file;
  if (!(file instanceof TlsContext)) throw new KernelError('EBADF', 'not a tls context');
  const held = open.retain();
  let released = false;
  return {
    leaf: file.leaf,
    done: () => {
      if (released) return;
      released = true;
      void held.release();
    },
  };
}

function choiceOf(fds: FdTable, pause: Pause, req: SelectRequest): ServerChoice {
  if (req.refuse !== undefined) {
    if (!REFUSALS.has(req.refuse)) throw new KernelError('EINVAL', 'not a refusal alert');
    return { refuse: req.refuse };
  }
  if (req.alpn !== undefined && !pause.offer.protocols.includes(req.alpn))
    throw new KernelError('EINVAL', 'ERR_TLS_ALPN_CALLBACK_INVALID_RESULT: not offered');
  return {
    ...(req.context === undefined ? {} : contextAt(fds, req.context)),
    ...(req.alpn === undefined ? {} : { alpn: req.alpn }),
  };
}

export async function selectSecure(
  fds: FdTable,
  socket: KernelSocket,
  req: SelectRequest
): Promise<ServedSession> {
  const selecting = selections.get(socket);
  if (!selecting) throw new KernelError('EINVAL', 'no handshake waits for a selection');
  selections.delete(socket);
  let choice: ServerChoice;
  try {
    choice = choiceOf(fds, selecting.pause, req);
  } catch (err) {
    selecting.pause.choose({ refuse: 40 });
    throw err;
  }
  selecting.pause.choose(choice);
  try {
    return servedOf(await selecting.run);
  } finally {
    choice.done?.();
  }
}
