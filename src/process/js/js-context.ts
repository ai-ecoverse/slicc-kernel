import { physicalPathAsync } from '../../fs/physical-path.ts';
import { SIG } from '../../kernel/signals.ts';
import { parseSyncFsStat, type SyncFsBridgeStat } from '../../realm/sync-fs-wire.ts';
import { KERNEL_VERSION } from '../../version.ts';
import {
  childOps,
  type JsChild,
  type JsExited,
  type JsSpawnOptions,
  type JsWaitOptions,
} from './js-children.ts';
import {
  devAsync,
  devExists,
  devOpen,
  devReaddir,
  devReadlink,
  devResolveTarget,
  devStat,
  inDev,
  readWhole,
  streamFile,
} from './js-dev.ts';
import { exitAtOnce, type PendingWrite, type SavedMode } from './js-exit.ts';
import { fetchOp } from './js-fetch.ts';
import {
  absent,
  brokenPipe,
  CHUNK,
  checkOpen,
  type FdInfo,
  fileWrite,
  index,
  isExclusive,
  type JsFdType,
  type JsOpenOptions,
  type JsStatFs,
  joined,
  MAX_IO,
  openRequest,
  readDevice,
  statFsOf,
  typeOf,
  writeDevice,
  written,
} from './js-io.ts';
import { callError, JsCallError, type JsKernel, modeOf, umaskRequest } from './js-kernel.ts';
import { type JsNet, netOps } from './js-net.ts';
import { procFsAsync, procOpenAsync } from './js-proc.ts';
import { runSync } from './js-run.ts';
import {
  type JsCred,
  type JsSyncContext,
  JsSyncKernel,
  laneOf,
  noLane,
  type SyncCall,
  type SyncShared,
  syncOps,
} from './js-sync.ts';
import { type JsTty, ttyOps } from './js-tty.ts';
import {
  follow,
  type JsWatcher,
  type JsWatchListener,
  type JsWatchOptions,
  watchArgs,
  watchRequest,
} from './js-watch.ts';
import { type JsWebSocket, type JsWebSocketOptions, websocketOp } from './js-websocket.ts';

export type { JsFdType, JsOpenOptions } from './js-io.ts';

export interface JsFile {
  readonly fd: number;
  readonly path: string;
  size(): Promise<number>;
  read(position: number, length: number): Promise<Uint8Array>;
  write(position: number, data: Uint8Array): Promise<number>;
  truncate(size: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface JsFdStatus {
  type: JsFdType;
  tty: boolean;
  seekable: boolean;
}

export type JsSignal = number | `SIG${string}`;

export interface JsKernelInfo {
  readonly version: string;
}

export const KERNEL_INFO: JsKernelInfo = Object.freeze({ version: KERNEL_VERSION });

export interface JsProgramContext {
  readonly kernel: JsKernelInfo;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly pid: number;
  ppid(): Promise<number>;
  readonly cwd: string;
  readonly stdin: ReadableStream<Uint8Array>;
  readonly stdout: WritableStream<Uint8Array>;
  readonly stderr: WritableStream<Uint8Array>;
  read(fd: number, max?: number): Promise<Uint8Array>;
  write(fd: number, data: Uint8Array | string): Promise<void>;
  close(fd: number): Promise<void>;
  socketpair(): Promise<[number, number]>;
  pipe(): Promise<[number, number]>;
  fdStatus(fd: number): Promise<JsFdStatus>;
  isatty(fd: number): Promise<boolean>;
  open(path: string, options?: JsOpenOptions): Promise<JsFile>;
  resolve(path: string): string;
  fs: {
    stat(path: string): Promise<SyncFsBridgeStat>;
    lstat(path: string): Promise<SyncFsBridgeStat>;
    exists(path: string): Promise<boolean>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
    rm(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    link(from: string, to: string): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    statfs(path: string): Promise<JsStatFs>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
    watch(
      path: string,
      options: JsWatchOptions | JsWatchListener,
      listener?: JsWatchListener
    ): Promise<JsWatcher>;
  };
  signals: {
    on(signal: JsSignal, handler: (signal: number) => void): Promise<void>;
    ignore(signal: JsSignal): Promise<void>;
    reset(signal: JsSignal): Promise<void>;
  };
  sync: JsSyncContext;
  spawn(options: JsSpawnOptions): Promise<JsChild>;
  wait(pid: number, options?: JsWaitOptions): Promise<JsExited>;
  kill(pid: number, signal?: JsSignal): Promise<void>;
  sudo(args: readonly string[]): Promise<JsSudoAnswer>;
  crontab(call: JsCrontabCall): Promise<JsCrontabAnswer>;
  umask(mask?: number): Promise<number>;
  net: JsNet;
  websocket(url: string | URL, options?: JsWebSocketOptions): Promise<JsWebSocket>;
  tty: JsTty;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  exit(code?: number): never;
  onUncaught(listener: JsStrayListener): () => void;
  onUnhandledRejection(listener: JsStrayListener): () => void;
}

export interface JsCrontabCall {
  action: 'list' | 'remove' | 'install';
  user?: string;
  text?: string;
}

export type JsCrontabAnswer =
  | { text: string; error?: undefined }
  | { error: string; text?: undefined };

export type JsSudoAnswer =
  | { error: string; errno: string }
  | { list: string }
  | { run: string[] }
  | { pid: number };

export type JsStrayListener = (error: unknown, promise?: Promise<unknown>) => void;

export interface JsStrays {
  exception: Set<JsStrayListener>;
  rejection: Set<JsStrayListener>;
}

function listen(listeners: Set<JsStrayListener>, listener: JsStrayListener): () => void {
  const own = (error: unknown, promise?: Promise<unknown>) => listener(error, promise);
  listeners.add(own);
  return () => void listeners.delete(own);
}

export class JsExit extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`exit ${status}`);
    this.name = 'JsExit';
    this.status = status;
  }
}

export interface ContextOptions {
  kernel: JsKernel;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  pid: number;
  ppid: number;
  cwd: string;
  exit(status: number): void;
  random?: (bytes: Uint8Array) => void;
  lane?: SyncCall;
  strays?: JsStrays;
}

const encoder = new TextEncoder();

export interface Identity {
  pid: number;
  ppid: number;
}

export function identityOf(answer: unknown, fallback: { pid: number; ppid?: number }): Identity {
  const id = answer as Partial<Identity> | null;
  return {
    pid: typeof id?.pid === 'number' ? id.pid : fallback.pid,
    ppid: typeof id?.ppid === 'number' ? id.ppid : (fallback.ppid ?? 1),
  };
}

export function signalNumber(signal: JsSignal): number {
  if (typeof signal === 'number') {
    if (Number.isInteger(signal) && signal >= 1 && signal <= 31) return signal;
    throw new JsCallError('EINVAL', `signal ${signal}`);
  }
  const name = signal.slice(3);
  if (!signal.startsWith('SIG') || !Object.hasOwn(SIG, name)) {
    throw new JsCallError('EINVAL', `signal ${signal}`);
  }
  return (SIG as Record<string, number>)[name] as number;
}

export function resolvePath(cwd: string, path: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export interface CreatedContext {
  ctx: JsProgramContext;
  drain(): Promise<unknown>;
}

interface KillerDeps {
  self: number;
  kernel: JsKernel;
  syncKernel: JsSyncKernel;
  lane: SyncCall;
  writes: Set<PendingWrite>;
  modes: () => SavedMode[];
}

function killer(d: KillerDeps): JsSyncContext['kill'] {
  return (pid, signal = 'SIGTERM') => {
    const sig = signal === 0 ? 0 : signalNumber(signal);
    const self = sig !== 0 && includesSelf(d.syncKernel, d.self, pid);
    if (!self || d.kernel.disposition(sig) !== 'terminate') {
      d.syncKernel.call({ op: 'proc-kill', pid, sig });
      return;
    }
    const target = pid === d.self ? {} : { target: pid };
    const r = d.lane({ op: 'proc-kill-self', sig, ...target, probe: true });
    if (!r.ok) throw new JsCallError(r.errno, 'kill');
    if (r.kind === 'void') return;
    exitAtOnce(d.lane, [...d.writes], d.modes(), 128 + sig, {
      op: 'proc-kill-self',
      sig,
      ...target,
    });
  };
}

function includesSelf(kernel: JsSyncKernel, self: number, pid: number): boolean {
  if (pid === self || pid === 0) return true;
  if (pid > 0 || pid === -1) return false;
  return kernel.json({ op: 'proc-getpgid', pid: 0 }) === -pid;
}

function writer(kernel: JsKernel, info: (fd: number) => Promise<FdInfo>, pid: number) {
  const writes = new Set<PendingWrite>();
  const sendAll = async (
    fd: number,
    data: Uint8Array,
    i: FdInfo,
    w: PendingWrite,
    signal?: AbortSignal
  ): Promise<void> => {
    while (w.at < data.length) {
      const body = data.subarray(w.at, w.at + MAX_IO);
      w.len = body.length;
      try {
        w.at += signal
          ? await sendSome(kernel, fd, body, signal)
          : written(
              await kernel.blocking({ op: 'fd-write', fd, body }, undefined, (id) => {
                if (w.op !== undefined) kernel.ack(w.op);
                w.op = id;
              }),
              body.length
            );
        if (w.op !== undefined) kernel.ack(w.op);
        w.op = undefined;
      } catch (err) {
        if (brokenPipe(err, i)) await kernel.call({ op: 'proc-kill', pid, sig: SIG.PIPE });
        throw err;
      }
    }
  };
  const writeAll = async (fd: number, data: Uint8Array, signal?: AbortSignal): Promise<void> => {
    const w: PendingWrite = { fd, data, at: 0, len: 0 };
    if (!signal) writes.add(w);
    try {
      const i = await info(fd);
      if (writeDevice(i)) return;
      await sendAll(fd, data, i, w, signal);
    } finally {
      writes.delete(w);
    }
  };

  return { writes, writeAll };
}

function readable(read: (fd: number) => Promise<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const chunk = await read(0);
        if (chunk.length === 0) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 }
  );
}

async function resolveDevAsync(kernel: JsKernel, abs: string): Promise<string | undefined> {
  try {
    const resolved = await physicalPathAsync(
      {
        async lstat(p) {
          return parseSyncFsStat(await kernel.json({ op: 'lstat', path: p })) ?? {};
        },
        async readlink(p) {
          return String(await kernel.json({ op: 'readlink', path: p }));
        },
      },
      abs
    );
    return resolved !== abs && inDev(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function vfsStat(
  kernel: JsKernel,
  abs: string,
  op: 'stat' | 'lstat',
  tryDev: (abs: string) => Promise<string | undefined>
): Promise<SyncFsBridgeStat> {
  try {
    await kernel.call({ op: 'fd-path-flush', path: abs });
    const s = parseSyncFsStat(await kernel.json({ op, path: abs }));
    if (!s) throw new JsCallError('EIO', op);
    return s;
  } catch (err) {
    if (!(err instanceof JsCallError) || err.code !== 'ENOENT') throw err;
    const devPath = await tryDev(abs);
    if (!devPath) throw err;
    return devAsync(kernel, devStat(devPath, op === 'stat'));
  }
}

interface PipeIo {
  infos: Map<number, FdInfo>;
  handles: Map<number, () => void>;
  read(fd: number, max?: number, signal?: AbortSignal): Promise<Uint8Array>;
  write(fd: number, data: Uint8Array, signal?: AbortSignal): Promise<void>;
}

async function fifoOpen(
  kernel: JsKernel,
  abs: string,
  options: JsOpenOptions,
  io: PipeIo
): Promise<JsFile> {
  options.signal?.throwIfAborted();
  const req = { ...openRequest(abs, { ...options, create: false }), fifo: true };
  const r = await kernel.blocking(req, options.signal);
  const fd = (r.ok && r.kind === 'json' ? r.json : -1) as number;
  io.infos.set(fd, { kind: 'stream' });
  let open = true;
  const live = (): void => {
    if (!open) throw new JsCallError('EBADF', abs);
  };
  const seekless = (position: number, what: string): void => {
    live();
    if (position !== 0) throw new JsCallError('ESPIPE', what);
  };
  io.handles.set(fd, () => {
    open = false;
  });
  return {
    fd,
    path: abs,
    async size() {
      live();
      return 0;
    },
    async read(position, length) {
      seekless(position, 'read');
      return io.read(fd, length);
    },
    async write(position, data) {
      seekless(position, 'write');
      await io.write(fd, data);
      return data.length;
    },
    async truncate() {
      live();
      throw new JsCallError('EINVAL', 'truncate');
    },
    sync: async () => live(),
    async close() {
      if (!open) return;
      open = false;
      io.infos.delete(fd);
      io.handles.delete(fd);
      await kernel.raw({ op: 'fd-close', fd });
    },
  };
}

async function vfsOpen(
  kernel: JsKernel,
  abs: string,
  options: JsOpenOptions,
  statOf: (op: 'stat' | 'lstat', path: string) => Promise<SyncFsBridgeStat>,
  io: PipeIo,
  whole: boolean
): Promise<JsFile> {
  const { infos, handles } = io;
  const existing = await statOf(isExclusive(options) ? 'lstat' : 'stat', abs).catch(absent);
  checkOpen(abs, options, existing);
  const special = existing?.isSocket || (whole && existing?.isFifo);
  if (special && !isExclusive(options)) throw new JsCallError('ENXIO', abs);
  if (existing?.isFifo && !isExclusive(options)) return fifoOpen(kernel, abs, options, io);
  const fd = (await kernel.json(openRequest(abs, options))) as number;
  try {
    await kernel.call({ op: 'fd-vfs-stat', fd });
  } catch (err) {
    await kernel.raw({ op: 'fd-close', fd });
    throw err;
  }
  infos.set(fd, { kind: 'file' });
  const handle = fileHandle(kernel, fd, abs, options.append === true, () => {
    infos.delete(fd);
    handles.delete(fd);
  });
  handles.set(fd, handle.invalidate);
  return handle.file;
}

function watchingSyncOps(kernel: JsKernel, syncKernel: JsSyncKernel, shared: SyncShared) {
  const ops = syncOps(syncKernel, shared);
  const watch: JsSyncContext['fs']['watch'] = (path, options, listener) => {
    const [given, onNote] = watchArgs(options, listener);
    const id = syncKernel.json(watchRequest(shared.resolve(path), given)) as number;
    return follow(kernel, id, onNote);
  };
  return { ...ops, fs: { ...ops.fs, watch } };
}

function pendingReads(
  kernel: ContextOptions['kernel'],
  info: (fd: number) => Promise<FdInfo>,
  random: (bytes: Uint8Array) => void
) {
  const reading = new Map<number, Set<AbortController>>();
  const read = async (fd: number, max = CHUNK, signal?: AbortSignal): Promise<Uint8Array> => {
    index(max, 'read');
    const emulated = readDevice(await info(fd), max, random);
    if (emulated) return emulated;
    const stop = new AbortController();
    const waits = reading.get(fd) ?? new Set();
    reading.set(fd, waits.add(stop));
    try {
      const n = Math.min(max, MAX_IO);
      if (signal) return await readPipe(kernel, fd, n, AbortSignal.any([signal, stop.signal]));
      const r = await kernel.blocking({ op: 'fd-read', fd, max: n }, stop.signal);
      return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
    } finally {
      waits.delete(stop);
      if (waits.size === 0 && reading.get(fd) === waits) reading.delete(fd);
    }
  };
  const closing = (fd: number) => {
    for (const stop of reading.get(fd) ?? []) stop.abort(new JsCallError('EBADF', 'read'));
    reading.delete(fd);
  };
  return { read, closing };
}

const cryptoRandom = (bytes: Uint8Array) =>
  void crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);

export function createContext(o: ContextOptions): CreatedContext {
  const { kernel } = o;
  const infos = new Map<number, FdInfo>();
  const handles = new Map<number, () => void>();
  const pending = new Set<Promise<unknown>>();
  const random = o.random ?? cryptoRandom;
  const resolve = (path: string) => resolvePath(o.cwd, path);
  const tryDev = (abs: string) => resolveDevAsync(kernel, abs);
  let exiting: number | undefined;
  const exit = (code = 0): never => {
    exiting ??= code;
    o.exit(code);
    throw new JsExit(code);
  };
  const unwind = (): void => {
    if (exiting !== undefined) throw new JsExit(exiting);
    if (kernel.faulted) throw new JsExit(1);
  };

  const info = async (fd: number): Promise<FdInfo> => {
    const known = infos.get(fd);
    if (known) return known;
    const got = (await kernel.json({ op: 'fd-info', fd })) as FdInfo;
    infos.set(fd, got);
    return got;
  };
  const { read, closing } = pendingReads(kernel, info, random);

  const { writes, writeAll } = writer(kernel, info, o.pid);

  const write = (fd: number, data: Uint8Array | string): Promise<void> => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    pending.add(settled);
    return (async () => {
      try {
        await writeAll(fd, bytes);
      } finally {
        pending.delete(settled);
        settle();
      }
    })();
  };

  const writable = (fd: number) =>
    new WritableStream<Uint8Array>({ write: (chunk) => write(fd, chunk) });

  const statOf = async (op: 'stat' | 'lstat', path: string): Promise<SyncFsBridgeStat> => {
    const abs = resolve(path);
    if (inDev(abs)) return devAsync(kernel, devStat(abs, op === 'stat'));
    return vfsStat(kernel, abs, op, tryDev);
  };

  const devIo = { infos, handles, read, write: writeAll };

  const open = async (
    path: string,
    options: JsOpenOptions = {},
    whole = false
  ): Promise<JsFile> => {
    const abs = resolve(path);
    if (inDev(abs)) return openDev(kernel, abs, options, devIo);
    try {
      return await vfsOpen(kernel, abs, options, statOf, devIo, whole);
    } catch (err) {
      if (!(err instanceof JsCallError) || err.code !== 'ENOENT') throw err;
      const devPath = await tryDev(abs);
      if (!devPath) throw err;
      return openDev(kernel, devPath, options, devIo);
    }
  };

  const fs = procFsAsync(pathOps(kernel, resolve, statOf, open, tryDev), kernel, {
    resolve,
    pid: o.pid,
  });
  const lane = o.lane ?? laneOf(undefined);
  if (o.lane && o.lane !== noLane) kernel.syncLane = o.lane;
  const syncKernel = new JsSyncKernel(lane, kernel, unwind);
  const terminal = ttyOps(kernel, syncKernel);
  const shared = { pid: o.pid, resolve, random, infos, handles, closing };
  const sync: JsSyncContext = {
    kernel: KERNEL_INFO,
    tty: terminal.syncTty,
    ...watchingSyncOps(kernel, syncKernel, shared),
    run: (options) =>
      runSync(syncKernel, { env: o.env, cwd: o.cwd, resolve, signal: signalNumber }, options),
    spawn: (options) => spawnSync(options),
    exit: (status = 0): never => {
      exiting ??= status & 0xff;
      return exitAtOnce(lane, [...writes], terminal.modes(), exiting);
    },
    kill: killer({ self: o.pid, kernel, syncKernel, lane, writes, modes: terminal.modes }),
    cred: () => syncKernel.json({ op: 'proc-cred' }) as JsCred,
    umask: (mask) => syncKernel.json(umaskRequest(mask)) as number,
    setcred(change) {
      if (typeof change !== 'object' || change === null || Array.isArray(change)) {
        throw new JsCallError('EINVAL', 'setcred');
      }
      return syncKernel.json({ op: 'proc-setcred', change: { ...change } }) as JsCred;
    },
  };

  const io = { read, send: writeAll, close: (fd: number) => ctx.close(fd) };
  const defaults = { env: o.env, cwd: o.cwd, signal: signalNumber };
  const { spawnSync, ...children } = childOps(kernel, io, defaults, syncKernel);

  const strays = o.strays ?? { exception: new Set(), rejection: new Set() };
  const ctx: JsProgramContext = {
    kernel: KERNEL_INFO,
    argv: o.argv,
    env: o.env,
    pid: o.pid,
    async ppid() {
      return identityOf(await kernel.json({ op: 'proc-identity' }), o).ppid;
    },
    cwd: o.cwd,
    stdin: readable(read),
    stdout: writable(1),
    stderr: writable(2),
    read,
    write,
    async close(fd) {
      handles.get(fd)?.();
      handles.delete(fd);
      infos.delete(fd);
      closing(fd);
      await kernel.call({ op: 'fd-close', fd });
    },
    socketpair: async () =>
      (await kernel.json({ op: 'sock-pair', domain: 'unix', type: 'stream' })) as [number, number],
    pipe: async () => (await kernel.json({ op: 'fd-pipe' })) as [number, number],
    async fdStatus(fd) {
      const type = typeOf(await info(fd));
      return { type, tty: type === 'tty', seekable: type === 'file' };
    },
    isatty: async (fd) => typeOf(await info(fd)) === 'tty',
    open: procOpenAsync(open, kernel, { resolve, pid: o.pid }),
    resolve,
    fs,
    signals: {
      on: async (signal, handler) => kernel.setHandler(signalNumber(signal), handler),
      ignore: async (signal) => kernel.setHandler(signalNumber(signal), 'ignore'),
      reset: async (signal) => kernel.setHandler(signalNumber(signal), 'default'),
    },
    sync,
    fetch: fetchOp(kernel),
    umask: async (mask) => (await kernel.json(umaskRequest(mask))) as number,
    sudo: async (args) =>
      (await kernel.json({
        op: 'proc-sudo',
        args: [...args],
        cwd: o.cwd,
        ...(o.env.TERM !== undefined ? { term: o.env.TERM } : {}),
      })) as JsSudoAnswer,
    crontab: async (call) =>
      (await kernel.json({ ...call, op: 'proc-crontab' })) as JsCrontabAnswer,
    ...children,
    net: netOps(kernel, io),
    websocket: websocketOp(kernel),
    tty: terminal.tty,
    exit,
    onUncaught: (listener) => listen(strays.exception, listener),
    onUnhandledRejection: (listener) => listen(strays.rejection, listener),
  };
  const drain = async (): Promise<void> => {
    for (;;) {
      await Promise.all([...pending]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (pending.size === 0) break;
    }
    await terminal.restore();
  };
  return { ctx, drain };
}

interface DevState {
  infos: Map<number, FdInfo>;
  handles: Map<number, () => void>;
  read(fd: number, max: number): Promise<Uint8Array>;
  write(fd: number, data: Uint8Array): Promise<void>;
}

async function openDev(
  kernel: JsKernel,
  abs: string,
  options: JsOpenOptions,
  state: DevState
): Promise<JsFile> {
  const { fd, file, ...access } = await devAsync(kernel, devOpen(abs, options));
  const forget = () => {
    state.infos.delete(fd);
    state.handles.delete(fd);
  };
  if (file) state.infos.set(fd, { kind: 'file' });
  const close = async (n: number) => {
    forget();
    await kernel.call({ op: 'fd-close', fd: n });
  };
  const handle = file
    ? fileHandle(kernel, fd, abs, options.append === true, forget)
    : streamFile(
        fd,
        abs,
        { read: (n, max) => state.read(n, max), write: state.write, close },
        access
      );
  state.handles.set(fd, handle.invalidate);
  return handle.file;
}

function fileHandle(
  kernel: JsKernel,
  fd: number,
  path: string,
  append: boolean,
  forget: () => void
): { file: JsFile; invalidate: () => void } {
  let open = true;
  const live = (): void => {
    if (!open) throw new JsCallError('EBADF', path);
  };
  const file: JsFile = {
    fd,
    path,
    async size() {
      live();
      const s = (await kernel.json({ op: 'fd-vfs-stat', fd })) as { size: number };
      return s.size;
    },
    async read(position, length) {
      index(position, 'read');
      index(length, 'read');
      const parts: Uint8Array[] = [];
      let got = 0;
      do {
        live();
        const max = Math.min(length - got, MAX_IO);
        if (max <= 0) break;
        const chunk = await kernel.bytes({ op: 'fd-pread', fd, offset: position + got, max });
        if (chunk.length === 0) break;
        parts.push(chunk);
        got += chunk.length;
      } while (got < length);
      return joined(parts, got);
    },
    async write(position, data) {
      index(position, 'write');
      let at = 0;
      do {
        live();
        if (at >= data.length) break;
        const body = data.subarray(at, at + MAX_IO);
        const n = (await kernel.json(fileWrite(fd, append, position + at, body))) as number;
        if (!(n > 0)) throw new JsCallError('EIO', 'write');
        at += n;
      } while (at < data.length);
      return at;
    },
    async truncate(size) {
      live();
      index(size, 'truncate');
      await kernel.call({ op: 'fd-resize', fd, size });
    },
    async sync() {
      live();
      await kernel.call({ op: 'fd-flush', fd });
    },
    async close() {
      live();
      open = false;
      forget();
      await kernel.call({ op: 'fd-close', fd });
    },
  };
  return {
    file,
    invalidate: () => {
      open = false;
    },
  };
}

async function readPipe(
  kernel: JsKernel,
  fd: number,
  max: number,
  signal: AbortSignal | undefined
): Promise<Uint8Array> {
  if (signal) return receiveSome(kernel, fd, max, signal);
  const r = await kernel.blocking({ op: 'fd-read', fd, max });
  return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
}

async function receiveSome(
  kernel: JsKernel,
  fd: number,
  max: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  for (;;) {
    signal.throwIfAborted();
    const r = await kernel.raw({ op: 'fd-read', fd, max, nonblock: true });
    if (r.ok) return r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
    if (r.errno !== 'EAGAIN') throw callError(r, 'fd-read');
    await kernel.blocking({ op: 'fd-select', read: [fd], write: [], timeoutMs: -1 }, signal);
  }
}

async function sendSome(
  kernel: JsKernel,
  fd: number,
  body: Uint8Array,
  signal: AbortSignal
): Promise<number> {
  for (;;) {
    signal.throwIfAborted();
    const r = await kernel.raw({ op: 'fd-write', fd, body, nonblock: true });
    if (r.ok) return written(r, body.length);
    if (r.errno !== 'EAGAIN') throw callError(r, 'fd-write');
    await kernel.blocking({ op: 'fd-select', read: [], write: [fd], timeoutMs: -1 }, signal);
  }
}

function pathOps(
  kernel: JsKernel,
  resolve: (path: string) => string,
  statOf: (op: 'stat' | 'lstat', path: string) => Promise<SyncFsBridgeStat>,
  open: (path: string, options?: JsOpenOptions, whole?: boolean) => Promise<JsFile>,
  tryDev: (abs: string) => Promise<string | undefined>
): JsProgramContext['fs'] {
  return {
    stat: (path) => statOf('stat', path),
    lstat: (path) => statOf('lstat', path),
    async exists(path) {
      const abs = resolve(path);
      if (inDev(abs)) return devAsync(kernel, devExists(abs));
      if ((await kernel.json({ op: 'exists', path: abs })) === true) return true;
      const devPath = await tryDev(abs);
      return devPath ? devAsync(kernel, devExists(devPath)) : false;
    },
    async readdir(path) {
      const abs = resolve(path);
      if (inDev(abs)) return devAsync(kernel, devReaddir(abs));
      return (await kernel.json({ op: 'readdir', path: abs })) as string[];
    },
    mkdir: async (path, options) =>
      void (await kernel.call({
        op: 'mkdir',
        path: resolve(path),
        ...(options?.recursive === false ? { exclusive: true } : {}),
        mode: options?.mode === undefined ? 0o777 : modeOf(options.mode),
      })),
    rm: async (path) => void (await kernel.call({ op: 'rm', path: resolve(path) })),
    unlink: async (path) => void (await kernel.call({ op: 'unlink', path: resolve(path) })),
    rename: async (from, to) =>
      void (await kernel.call({ op: 'rename', path: resolve(from), arg2: resolve(to) })),
    chmod: async (path, mode) =>
      void (await kernel.call({ op: 'chmod', path: resolve(path), mode: modeOf(mode) })),
    link: async (from, to) =>
      void (await kernel.call({ op: 'link', path: resolve(from), arg2: resolve(to) })),
    symlink: async (target, path) =>
      void (await kernel.call({ op: 'symlink', path: resolve(path), arg2: target })),
    async readlink(path) {
      const abs = resolve(path);
      if (inDev(abs)) return devAsync(kernel, devReadlink(abs));
      return String(await kernel.json({ op: 'readlink', path: abs }));
    },
    async statfs(path) {
      let abs = resolve(path);
      if (inDev(abs)) {
        const target = await devAsync(kernel, devResolveTarget(abs)).catch(() => undefined);
        if (target?.startsWith('/')) abs = target;
      }
      await statOf('stat', abs);
      return statFsOf(await kernel.json({ op: 'statfs', path: abs }));
    },
    async watch(path, options, listener) {
      const [given, onNote] = watchArgs(options, listener);
      const id = (await kernel.json(watchRequest(resolve(path), given))) as number;
      return follow(kernel, id, onNote);
    },
    async readFile(path) {
      const abs = resolve(path);
      if (inDev(abs)) return readWhole(await open(abs));
      try {
        await kernel.call({ op: 'fd-path-flush', path: abs });
        return await kernel.bytes({ op: 'read', path: abs });
      } catch (err) {
        if (!(err instanceof JsCallError) || err.code !== 'ENOENT') throw err;
        const devPath = await tryDev(abs);
        if (!devPath) throw err;
        return readWhole(await open(devPath));
      }
    },
    async writeFile(path, data, options) {
      const mode = options?.mode;
      const file = await open(
        path,
        { write: true, create: true, truncate: true, ...(mode !== undefined ? { mode } : {}) },
        true
      );
      try {
        await file.write(0, typeof data === 'string' ? encoder.encode(data) : data);
      } finally {
        await file.close();
      }
    },
  };
}
