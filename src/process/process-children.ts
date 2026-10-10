import type { ChildStdio, InheritedSlot } from '../kernel/children.ts';
import type { Cred, CredChange } from '../kernel/cred.ts';
import type { WasmSyscall } from '../kernel/process.ts';
import type { ForkState, ForkStream } from '../kernel/protocol.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import type { SyncSabTransport } from '../realm/sync-sab-bridge.ts';
import type { ProcessFs, ProcessStream } from './kernel-streams.ts';
import { deviceOfStream } from './process-fork.ts';
import type { HttpKernel } from './process-http.ts';
import type { SocketKernel } from './process-sockets.ts';
import { wasiErrno } from './wasi-errno.ts';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

const POLLIN = 0x001;
const POLLOUT = 0x004;
const POLLERR = 0x008;
const POLLHUP = 0x010;
const POLLNVAL = 0x020;

const SELECT_SLICE_MS = 20;

const WUNTRACED = 2;
const WCONTINUED = 8;

function status(r: SyncFsResult): number {
  return r.ok ? 0 : -wasiErrno(r.errno);
}

function credOf(r: SyncFsResult): Cred | number {
  return r.ok ? ((r as { json?: unknown }).json as Cred) : -wasiErrno(r.errno);
}

function number(r: SyncFsResult): number {
  if (!r.ok) return -wasiErrno(r.errno);
  return r.kind === 'json' && typeof r.json === 'number' ? r.json : -wasiErrno('EIO');
}

export interface ProcessKernel {
  spawn(
    file: string,
    argv: string[],
    env: Record<string, string> | null,
    cwd: string | null,
    stdio: number[],
    actions?: ReadonlyArray<readonly [number, number]>
  ): number;

  wait(pid: number, nohang: boolean, options?: number): [number, number] | number;

  fork(state: ForkState): number;

  kill(pid: number, sig: number): number;

  pause(): number;

  setpgid(pid: number, pgid: number): number;
  setsid(): number;

  getpgid(pid: number): number;
  getsid(pid: number): number;

  cred(): Cred | number;

  setcred(change: CredChange): Cred | number;

  tcgetpgrp(fd: number): number;

  tcsetpgrp(fd: number, pgrp: number): number;

  execWait(pid: number): number;

  execve(
    file: string,
    argv: string[],
    env: Record<string, string> | null,
    cwd: string | null
  ): number;

  mount(source: string, target: string, fstype: string, flags: number, data: string): number;

  umount2(target: string, flags: number): number;

  select(
    read: number[],
    write: number[],
    timeoutMs: number
  ): { read: number[]; write: number[] } | number;

  net?: SocketKernel;

  hostname?: string;

  http?: HttpKernel;
}

export interface ProcessKernelDeps {
  transport: SyncSabTransport;
  Fs: ProcessFs;

  env: Record<string, string>;

  beforeSpawn(): void;

  afterChild(): void;

  describeFork(): ForkStream[];

  inherit?(actions?: ReadonlyArray<readonly [number, number]>): InheritedSlot[];

  stdioPromoter?(): (stream: ProcessStream) => void;

  pid?: number;

  raise?(sig: number): void;

  restartable?(): boolean;

  memory?(): WebAssembly.Memory | undefined;

  deliveries?(): number;
}

function restarted(issue: () => SyncFsResult): SyncFsResult {
  for (;;) {
    const r = issue();
    if (r.ok || r.errno !== 'EINTR') return r;
  }
}

function forkRestarted(
  deps: ProcessKernelDeps,
  state: ForkState,
  snapshotAt: number | undefined
): SyncFsResult {
  let memory = state.memory;
  let seen = snapshotAt;
  return restarted(() => {
    const streams = deps.describeFork();
    const now = deps.deliveries?.();
    if (now !== seen) {
      seen = now;
      const live = deps.memory?.();
      if (live) memory = new Uint8Array(live.buffer).slice();
    }
    const forked = { ...state, memory, streams, cwd: deps.Fs.cwd() };
    return deps.transport.call(
      { op: 'proc-fork', state: forked, restart: true },
      Infinity,
      'proc-fork'
    );
  });
}

function flushed(beforeSpawn: () => void): number {
  try {
    beforeSpawn();
    return 0;
  } catch (err) {
    const errno = (err as { errno?: unknown } | null)?.errno;
    if (typeof errno !== 'number') throw err;
    return -errno;
  }
}

function drain(Fs: ProcessFs, stream: ProcessStream): Uint8Array {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(65536);
  try {
    for (let n = Fs.read(stream, buffer, 0, buffer.length); n > 0; ) {
      chunks.push(buffer.slice(0, n));
      n = Fs.read(stream, buffer, 0, buffer.length);
    }
  } catch {}
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function kernelSelect(
  Fs: ProcessFs,
  transport: SyncSabTransport,
  read: number[],
  write: number[],
  timeoutMs: number
): { read: number[]; write: number[] } | number {
  const kernel = (fd: number) => Fs.getStream(fd)?.sliccKernelFd as number;
  const kr = read.map(kernel);
  const kw = write.map(kernel);
  const r = transport.call({ op: 'fd-select', read: kr, write: kw, timeoutMs }, Infinity, 'select');
  if (!r.ok) return -wasiErrno(r.errno);
  const got = (r.kind === 'json' ? r.json : { read: [], write: [] }) as {
    read: number[];
    write: number[];
  };
  return {
    read: read.filter((_, i) => got.read.includes(kr[i] as number)),
    write: write.filter((_, i) => got.write.includes(kw[i] as number)),
  };
}

function ownReady(
  Fs: ProcessFs,
  read: number[],
  write: number[]
): { read: number[]; write: number[] } {
  const flags = (fd: number): number => {
    const stream = Fs.getStream(fd);
    if (!stream) return POLLNVAL;
    return stream.stream_ops.poll ? stream.stream_ops.poll(stream) : POLLIN | POLLOUT;
  };
  return {
    read: read.filter((fd) => flags(fd) & (POLLIN | POLLHUP | POLLERR | POLLNVAL)),
    write: write.filter((fd) => flags(fd) & (POLLOUT | POLLERR | POLLNVAL)),
  };
}

function anySelect(
  Fs: ProcessFs,
  transport: SyncSabTransport,
  read: number[],
  write: number[],
  timeoutMs: number
): { read: number[]; write: number[] } | number {
  const kernel = (fd: number) => Fs.getStream(fd)?.sliccKernelFd;
  const own = (fd: number) => kernel(fd) === undefined;
  if (![...read, ...write].some(own)) return kernelSelect(Fs, transport, read, write, timeoutMs);
  const deadline = timeoutMs < 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  const kernelRead = read.filter((fd) => !own(fd));
  const kernelWrite = write.filter((fd) => !own(fd));
  for (;;) {
    const local = ownReady(Fs, read.filter(own), write.filter(own));
    const pending = local.read.length > 0 || local.write.length > 0;
    const slice = pending ? 0 : Math.min(SELECT_SLICE_MS, Math.max(0, deadline - Date.now()));
    const got = kernelSelect(Fs, transport, kernelRead, kernelWrite, slice);
    if (typeof got === 'number') return got;
    const ready = { read: [...local.read, ...got.read], write: [...local.write, ...got.write] };
    if (ready.read.length > 0 || ready.write.length > 0 || Date.now() >= deadline) {
      return ready;
    }
  }
}

export function createProcessKernel(deps: ProcessKernelDeps): ProcessKernel {
  const { transport, Fs } = deps;

  const reaped = new Map<number, number>();

  const call = (req: WasmSyscall, label: string): SyncFsResult =>
    transport.call(req, Infinity, label);

  const at = (path: string) => (path === '' || path.startsWith('/') ? path : `${Fs.cwd()}/${path}`);

  const slot = (fd: number, n: number, promote?: (stream: ProcessStream) => void): ChildStdio => {
    const stream = fd >= 0 ? Fs.getStream(fd) : null;
    if (!stream) return { none: true };
    promote?.(stream);
    if (stream.sliccKernelFd !== undefined) return { fd: stream.sliccKernelFd };

    if (((stream.node?.mode ?? 0) & S_IFMT) === S_IFDIR && stream.path) return { dir: stream.path };
    const device = deviceOfStream(stream);
    if (device) return device;
    return n === 0 ? { input: drain(Fs, stream) } : { capture: true };
  };

  const kernelWait = (pid: number, nohang: boolean, options = 0): [number, number] | number => {
    const req = {
      op: 'proc-wait' as const,
      pid,
      nohang,
      ...(options & WUNTRACED ? { untraced: true } : {}),
      ...(options & WCONTINUED ? { continued: true } : {}),
    };
    let r = transport.call(req, Infinity, `proc-wait ${pid}`);

    while (!r.ok && r.errno === 'EINTR' && deps.restartable?.()) {
      r = transport.call(req, Infinity, `proc-wait ${pid}`);
    }
    if (!r.ok) return -wasiErrno(r.errno);
    const waited = r.kind === 'json' ? (r.json as [number, number]) : [0, 0];
    if (waited[0] > 0) deps.afterChild();
    return [waited[0], waited[1]];
  };

  const deliver = (pid: number, n: number, fd: number): void => {
    const r = transport.call(
      { op: 'proc-captured', pid, slot: n },
      Infinity,
      `proc-captured ${pid}`
    );
    const stream = Fs.getStream(fd);
    if (r.ok && r.kind === 'bytes' && r.bytes.length > 0 && stream) {
      Fs.write(stream, r.bytes, 0, r.bytes.length);
    }
  };

  const execCaptures = new Map<number, () => void>();

  const execWait = (pid: number): number => {
    const r = transport.call({ op: 'proc-exec', pid }, Infinity, `exec ${pid}`);
    if (!r.ok) return -wasiErrno(r.errno);
    deps.afterChild();
    return r.kind === 'json' ? (r.json as [number, number])[1] : 0;
  };

  const spawnChild = (
    file: string,
    argv: string[],
    env: Record<string, string> | null,
    cwd: string | null,
    fds: number[],
    actions: ReadonlyArray<readonly [number, number]> | undefined,
    exec: boolean
  ): number => {
    const unflushed = flushed(deps.beforeSpawn);
    if (unflushed < 0) return unflushed;
    const promote = deps.stdioPromoter?.();
    const stdio = [0, 1, 2].map((n) => slot(fds[n] ?? -1, n, promote));
    const inherit = deps.inherit?.(actions) ?? [];
    const req = {
      op: 'proc-spawn' as const,
      file,
      argv,
      env: env ?? deps.env,
      cwd: cwd ?? Fs.cwd(),
      stdio,
      ...(inherit.length > 0 ? { inherit } : {}),
      ...(exec ? { exec } : {}),
      restart: true as const,
    };
    const r = restarted(() => transport.call(req, Infinity, `proc-spawn ${file}`));
    if (!r.ok) return -wasiErrno(r.errno);
    const pid = r.kind === 'json' ? (r.json as number) : 0;
    const captures = [1, 2].filter((n) => 'capture' in (stdio[n] as ChildStdio));
    if (captures.length === 0) return pid;
    if (exec) {
      execCaptures.set(pid, () => {
        for (const n of captures) deliver(pid, n, fds[n] as number);
      });
      return pid;
    }
    const waited = kernelWait(pid, false);
    if (typeof waited === 'number') return waited;
    for (const n of captures) deliver(pid, n, fds[n] as number);
    reaped.set(pid, waited[1]);
    return pid;
  };

  return {
    spawn(file, argv, env, cwd, fds, actions) {
      return spawnChild(file, argv, env, cwd, fds, actions, false);
    },
    fork(state) {
      const snapshotAt = deps.deliveries?.();
      const unflushed = flushed(deps.beforeSpawn);
      if (unflushed < 0) return unflushed;
      const r = forkRestarted(deps, state, snapshotAt);
      if (!r.ok) return -wasiErrno(r.errno);
      return r.kind === 'json' ? (r.json as number) : -wasiErrno('EIO');
    },
    select: (read, write, timeoutMs) => anySelect(Fs, transport, read, write, timeoutMs),
    execWait: execWait,
    execve(file, argv, env, cwd) {
      const pid = spawnChild(file, argv, env, cwd, [0, 1, 2], undefined, true);
      if (pid < 0) return pid;
      const status = execWait(pid);
      execCaptures.get(pid)?.();
      execCaptures.delete(pid);
      return status;
    },
    pause() {
      return status(call({ op: 'sig-pause' }, 'pause'));
    },
    mount(source, target, type, flags, data) {
      const req = { op: 'mount' as const, source, target: at(target), type, flags, data };
      return status(call(req, `mount ${target}`));
    },
    umount2(target, flags) {
      return status(call({ op: 'umount', target: at(target), flags }, `umount ${target}`));
    },
    kill(pid, sig) {
      if (pid === deps.pid) {
        if (sig !== 0) deps.raise?.(sig);
        return 0;
      }
      return status(call({ op: 'proc-kill', pid, sig }, `kill ${pid}`));
    },
    setpgid: (pid, pgid) => status(call({ op: 'proc-setpgid', pid, pgid }, 'setpgid')),
    setsid: () => number(call({ op: 'proc-setsid' }, 'setsid')),
    getpgid: (pid) => number(call({ op: 'proc-getpgid', pid }, 'getpgid')),
    getsid: (pid) => number(call({ op: 'proc-getsid', pid }, 'getsid')),
    cred: () => credOf(call({ op: 'proc-cred' }, 'cred')),
    setcred: (change) => credOf(call({ op: 'proc-setcred', change }, 'setcred')),
    tcgetpgrp(fd) {
      const kfd = Fs.getStream(fd)?.sliccKernelFd;
      if (kfd === undefined) return -wasiErrno('ENOTTY');
      return number(call({ op: 'tty-pgrp-get', fd: kfd }, 'tcgetpgrp'));
    },
    tcsetpgrp(fd, pgrp) {
      const kfd = Fs.getStream(fd)?.sliccKernelFd;
      if (kfd === undefined) return -wasiErrno('ENOTTY');
      return status(call({ op: 'tty-pgrp-set', fd: kfd, pgrp }, 'tcsetpgrp'));
    },
    wait(pid, nohang, options) {
      const key = pid > 0 ? (reaped.has(pid) ? pid : undefined) : reaped.keys().next().value;
      if (key !== undefined) {
        const status = reaped.get(key) as number;
        reaped.delete(key);
        return [key, status];
      }
      return kernelWait(pid, nohang, options);
    },
  };
}
