import type { MountCall } from '../mount/syscall.ts';
import type { LinkRecord } from '../process/wasi/wasix-linker.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import {
  type ChildForker,
  type ChildSpawner,
  type ChildStdio,
  ChildTable,
  type InheritedSlot,
  SpawnError,
} from './children.ts';
import {
  type FdTable,
  type HeldMeta,
  heldFile,
  KernelError,
  type KernelFdKind,
  kernelFdKind,
  type OpenFile,
  openPipe,
  pollFile,
} from './fd-table.ts';
import { AsyncOps, HOST_OPS, type HostSyscall, hostSyscall, type LockTable } from './host-ops.ts';
import type { JobTable } from './jobs.ts';
import { HTTP_OPS, type HttpHandles, type HttpSyscall } from './net/http-syscalls.ts';
import { NO_TRANSPORT } from './net/network.ts';
import { Resolver } from './net/resolver.ts';
import { Routes } from './net/routes.ts';
import type { MountLine, ProcessListing } from './proc-info.ts';
import type { ForkState } from './protocol.ts';
import { PTY_OPS, type PtySyscall, type PtyTable, ptySyscall } from './pty.ts';
import { selectFds } from './select.ts';
import { type DefaultAction, defaultAction, isSignal, SIG, sigbit } from './signals.ts';
import { KernelSocket, LoopbackNet } from './socket.ts';
import { SOCKET_OPS, type SocketSyscall, socketSyscall } from './socket-syscalls.ts';
import type { KernelTty, Termios } from './tty.ts';
import {
  present,
  refuseReadonly,
  type VersionPin,
  type VfsFileFs,
  VfsNodes,
  vfsFile,
} from './vfs-file.ts';

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new KernelError('EINTR')), { once: true });
  });
}

export type WasmSyscall =
  | {
      op: 'fd-read';
      fd: number;
      max: number;

      nonblock?: boolean;

      peek?: boolean;
    }
  | { op: 'fd-write'; fd: number; body: Uint8Array; nonblock?: boolean }
  | { op: 'fd-close'; fd: number }
  | { op: 'fd-pipe' }
  | { op: 'fd-poll'; fd: number }
  | {
      op: 'fd-open-vfs';
      path: string;
      flags: number;
      position: number;

      contents?: Uint8Array;

      orphan?: boolean;

      truncate?: boolean;

      create?: boolean;

      exclusive?: boolean;

      existing?: boolean;

      pin?: VersionPin;
    }
  | { op: 'fd-pread'; fd: number; offset: number; max: number }
  | { op: 'fd-pwrite'; fd: number; offset: number; body: Uint8Array }
  | { op: 'fd-resize'; fd: number; size: number }
  | { op: 'fd-vfs-stat'; fd: number }
  | { op: 'fd-path-flush'; path: string }
  | { op: 'fd-path-unlinking'; path: string }
  | { op: 'fd-path-unlinked'; path: string }
  | { op: 'fd-path-renamed'; from: string; to: string }
  | { op: 'fd-seek'; fd: number; offset: number; whence: number }
  | { op: 'fd-select'; read: number[]; write: number[]; timeoutMs: number }
  | { op: 'fd-info'; fd: number }
  | { op: 'fd-dup'; fd: number; min?: number }
  | { op: 'fd-reserve'; fd?: number; min?: number; meta?: HeldMeta }
  | { op: 'fd-meta'; fd: number; meta: HeldMeta }
  | { op: 'fd-setfl'; fd: number; flags: number }
  | { op: 'fd-cloexec'; fd: number; on: boolean }
  | { op: 'fd-list' }
  | { op: 'dl-log'; append?: LinkRecord; from: number }
  | {
      op: 'proc-alarm';
      sig: number;
      ms: number;
      firstMs?: number;
      repeat: boolean;

      timer?: number;
    }
  | { op: 'fd-renumber'; from: number; to: number; keep?: boolean }
  | { op: 'proc-umask'; mask?: number }
  | {
      op: 'fd-promote';
      fd: number;
      share?: number;
      path?: string;
      flags?: number;
      position?: number;
      contents?: Uint8Array;
      orphan?: boolean;

      dirty?: boolean;

      pin?: VersionPin;
    }
  | { op: 'fd-open-tty'; name?: string }
  | { op: 'fd-tty-names' }
  | { op: 'tty-get'; fd: number }
  | { op: 'tty-set'; fd: number; termios: Termios }
  | { op: 'tty-winsz'; fd: number }
  | { op: 'fd-flush'; fd: number }
  | {
      op: 'proc-spawn';
      file: string;
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      stdio: ChildStdio[];

      inherit?: InheritedSlot[];

      exec?: boolean;
    }
  | {
      op: 'proc-wait';
      pid: number;
      nohang: boolean;

      untraced?: boolean;
      continued?: boolean;
    }
  | { op: 'proc-captured'; pid: number; slot: number }
  | { op: 'proc-fork'; state: ForkState }
  | { op: 'proc-kill'; pid: number; sig: number }
  | { op: 'proc-list' }
  | { op: 'mount-list' }
  | ({ op: 'mount' } & MountCall)
  | { op: 'umount'; target: string; flags: number }
  | { op: 'proc-exec'; pid: number }
  | { op: 'proc-identity' }
  | { op: 'proc-setpgid'; pid: number; pgid: number }
  | { op: 'proc-getpgid'; pid: number }
  | { op: 'proc-getsid'; pid: number }
  | { op: 'proc-setsid' }
  | { op: 'tty-pgrp-get'; fd: number }
  | { op: 'tty-pgrp-set'; fd: number; pgrp: number }
  | { op: 'sig-mask'; caught: number; ignored: number; defaults?: number }
  | { op: 'sig-pause' }
  | SocketSyscall
  | HttpSyscall
  | PtySyscall
  | HostSyscall;

type FdSyscall = Extract<WasmSyscall, { op: `fd-${string}` }>;

type JobSyscall = Extract<
  WasmSyscall,
  { op: 'proc-setpgid' | 'proc-getpgid' | 'proc-getsid' | 'proc-setsid' }
>;

const JOB_OPS: ReadonlySet<string> = new Set([
  'proc-setpgid',
  'proc-getpgid',
  'proc-getsid',
  'proc-setsid',
]);

function isJobSyscall(req: WasmSyscall): req is JobSyscall {
  return JOB_OPS.has(req.op);
}

function isHttpSyscall(req: WasmSyscall): req is HttpSyscall {
  return req.op.startsWith('net-');
}

function isSocketSyscall(req: WasmSyscall): req is SocketSyscall {
  return req.op.startsWith('sock-');
}

function isHostSyscall(req: { op: string }): req is HostSyscall {
  return (HOST_OPS as readonly string[]).includes(req.op);
}

function isPtySyscall(req: WasmSyscall): req is PtySyscall {
  return req.op.startsWith('pty-');
}

type VfsSyscall = Extract<
  FdSyscall,
  {
    op:
      | 'fd-pread'
      | 'fd-pwrite'
      | 'fd-resize'
      | 'fd-vfs-stat'
      | 'fd-path-flush'
      | 'fd-path-unlinking'
      | 'fd-path-unlinked'
      | 'fd-path-renamed';
  }
>;

function isVfsSyscall(req: FdSyscall): req is VfsSyscall {
  return (
    req.op.startsWith('fd-path-') ||
    req.op === 'fd-pread' ||
    req.op === 'fd-pwrite' ||
    req.op === 'fd-resize' ||
    req.op === 'fd-vfs-stat'
  );
}

function isFdSyscall(req: WasmSyscall): req is FdSyscall {
  return req.op.startsWith('fd-');
}

function isTtySyscall(req: WasmSyscall): req is TtySyscall {
  return req.op.startsWith('tty-');
}

export interface FdInfo {
  tty: boolean;
  kind: KernelFdKind;
  meta?: HeldMeta;
  flags?: number;
  cloexec?: true;

  name?: string;
}

const SYSCALL_OPS: ReadonlySet<string> = new Set([
  'fd-read',
  'fd-write',
  'fd-close',
  'fd-pipe',
  'fd-poll',
  'fd-open-vfs',
  'fd-seek',
  'fd-pread',
  'fd-pwrite',
  'fd-resize',
  'fd-vfs-stat',
  'fd-path-flush',
  'fd-path-unlinking',
  'fd-path-unlinked',
  'fd-path-renamed',
  'fd-select',
  'fd-info',
  'fd-dup',
  'fd-reserve',
  'fd-meta',
  'fd-setfl',
  'fd-cloexec',
  'fd-list',
  'proc-alarm',
  'proc-umask',
  'dl-log',
  'fd-renumber',
  'fd-promote',
  'fd-open-tty',
  'fd-tty-names',
  'tty-get',
  'tty-set',
  'tty-winsz',
  'fd-flush',
  'proc-spawn',
  'proc-wait',
  'proc-captured',
  'proc-fork',
  'proc-kill',
  'proc-list',
  'mount-list',
  'mount',
  'umount',
  'proc-exec',
  'proc-identity',
  'proc-setpgid',
  'proc-getpgid',
  'proc-getsid',
  'proc-setsid',
  'tty-pgrp-get',
  'tty-pgrp-set',
  'sig-mask',
  'sig-pause',
  ...SOCKET_OPS,
  ...HTTP_OPS,
  ...PTY_OPS,
  ...HOST_OPS,
]);

type TtySyscall = Extract<WasmSyscall, { op: `tty-${string}` }>;

export function isWasmSyscall(req: object): req is WasmSyscall {
  const op = (req as { op?: unknown }).op;
  return typeof op === 'string' && SYSCALL_OPS.has(op);
}

const MAX_READ = 1024 * 1024;

export const DEFAULT_UMASK = 0o022;

const DYING: SyncFsResult = { ok: false, errno: 'EINTR', message: 'the process is being killed' };

const HOSTS_ONLY = new Resolver({ routes: new Routes() });

export interface WasmProcessOptions {
  ignored?: number;

  umask?: number;

  identity?: () => Promise<{ pid: number; ppid: number }>;

  onSyscall?: (req: WasmSyscall) => void;

  spawner?: ChildSpawner;

  forker?: ChildForker;

  fs: VfsFileFs;

  kill?: (pid: number, sig: number) => boolean | Promise<boolean>;

  writesBack?: (pid: number) => boolean;

  processes?: () => ProcessListing;

  openFiles?: Set<VfsNodes>;

  nodes?: VfsNodes;

  mounts?: () => MountLine[];

  mount?: (call: MountCall, signal: AbortSignal) => Promise<unknown>;

  umount?: (target: string, flags: number) => Promise<void>;

  onPending?: (sig: number) => void;

  onTimer?: (which: number) => void;

  onAsync?: () => void;

  hasPending?: () => boolean;

  pendingBits?: () => number;

  raise?: (sig: number) => void;

  onReap?: (pid: number) => void;

  jobs?: JobTable;

  ptys?: PtyTable;

  net?: LoopbackNet;

  http?: HttpHandles;

  locks?: LockTable;

  resolver?: Resolver;
}

export type StateListener = (state: 'stopped' | 'continued', sig: number) => void;

export type SignalOutcome = DefaultAction | 'deliver' | 'forward';

export class WasmProcess {
  private exited = false;
  private readonly children: ChildTable;

  private caught = 0;
  private ignored = 0;
  private inherited = 0;

  private interrupt = new AbortController();

  private dying = false;

  umask = DEFAULT_UMASK;

  private execChild: number | undefined;

  execTermsig: number | undefined;

  private stopped = 0;

  private stops = 0;
  private resumed: Promise<void> = Promise.resolve();
  private wake: (() => void) | undefined;
  private readonly stateListeners: StateListener[] = [];

  private net: LoopbackNet | undefined;

  private readonly nodes: VfsNodes;

  readonly pid: number;

  readonly fds: FdTable;

  private readonly options: WasmProcessOptions;

  constructor(
    pid: number,

    fds: FdTable,

    options: WasmProcessOptions
  ) {
    this.pid = pid;

    this.fds = fds;

    this.options = options;
    this.inherited = options.ignored ?? 0;
    this.umask = options.umask ?? DEFAULT_UMASK;
    this.children = new ChildTable(fds, options.spawner, options.forker);
    this.nodes = options.nodes ?? new VfsNodes(options.fs);
    if (!options.nodes) options.openFiles?.add(this.nodes);
    this.children.onChildState = () => this.signal(SIG.CHLD);
    this.children.onReap = options.onReap;
  }

  private ignores(bit: number): boolean {
    return ((this.ignored | (this.inherited & ~this.caught)) & bit) !== 0;
  }

  inheritable(fork = false): number {
    return ((fork ? 0 : this.ignored) | this.inherited) & ~this.caught;
  }

  signal(sig: number): SignalOutcome {
    if (this.execChild !== undefined) {
      void Promise.resolve(this.options.kill?.(this.execChild, sig)).catch(() => undefined);
      if (sig !== SIG.KILL) return 'forward';
      if (!this.options.writesBack?.(this.execChild)) return 'terminate';
      this.wake?.();
      return 'forward';
    }
    if (sig === SIG.KILL) return 'terminate';

    if (sig === SIG.CONT) this.cont();
    if (sig === SIG.STOP) return this.stop(sig);
    const bit = sigbit(sig);
    if (this.ignores(bit)) return 'ignore';
    if (!(this.caught & bit)) {
      const action = defaultAction(sig);
      return action === 'stop' ? this.stop(sig) : action;
    }
    if (((this.options.pendingBits?.() ?? 0) & bit) !== 0 && defaultAction(sig) === 'terminate') {
      return 'terminate';
    }
    this.options.onPending?.(sig);
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
    return 'deliver';
  }

  onState(listener: StateListener): void {
    this.stateListeners.push(listener);
  }

  private stop(sig: number): 'stop' {
    if (this.stopped) return 'stop';
    this.stopped = sig;
    this.stops++;
    this.resumed = new Promise((resolve) => (this.wake = resolve));
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
    for (const listener of this.stateListeners) listener('stopped', sig);
    return 'stop';
  }

  private cont(): void {
    if (!this.stopped) return;
    this.stopped = 0;
    this.wake?.();
    for (const listener of this.stateListeners) listener('continued', SIG.CONT);
  }

  async syscall(req: WasmSyscall, cancelled?: AbortSignal): Promise<SyncFsResult> {
    this.options.onSyscall?.(req);
    for (;;) {
      await this.resumed;
      if (this.dying) return DYING;
      const stops = this.stops;
      const result = await this.dispatch(req, cancelled);
      if (this.dying) return DYING;

      const restart = !result.ok && result.errno === 'EINTR' && this.stops !== stops;
      if (restart && !this.options.hasPending?.()) continue;

      await this.resumed;
      return result;
    }
  }

  setUmask(mask?: number): number {
    const old = this.umask;
    if (mask !== undefined) this.umask = mask & 0o777;
    return old;
  }

  die(): void {
    if (this.dying) return;
    this.dying = true;
    this.interrupt.abort();
    this.wake?.();
  }

  private async dispatch(req: WasmSyscall, cancelled?: AbortSignal): Promise<SyncFsResult> {
    try {
      if (isFdSyscall(req)) return await this.fdSyscall(req, cancelled);
      if (isTtySyscall(req)) return this.ttySyscall(req);
      if (isJobSyscall(req)) return this.jobSyscall(req);
      if (isSocketSyscall(req)) return await this.socketSyscall(req);
      if (isHttpSyscall(req)) return await this.httpSyscall(req);
      if (isHostSyscall(req)) {
        return await hostSyscall(req, {
          pid: this.pid,
          locks: this.options.locks,
          ops: this.asyncOps,
          blocking: () => this.blockingSignal(),
          valid: (inner) => isWasmSyscall(inner) && !isHostSyscall(inner),
        });
      }
      if (isPtySyscall(req)) {
        const { ptys, jobs } = this.options;
        return ptySyscall(req, { pid: this.pid, fds: this.fds, ptys, jobs });
      }
      return await this.procSyscall(req);
    } catch (e) {
      if (e instanceof KernelError || e instanceof SpawnError) {
        return { ok: false, errno: e.code, message: e.code };
      }
      const code = (e as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
        return { ok: false, errno: code, message: code };
      }
      throw e;
    }
  }

  private blockingSignal(): AbortSignal {
    if (this.options.hasPending?.()) throw new KernelError('EINTR');
    return this.interrupt.signal;
  }

  private async read(req: Extract<WasmSyscall, { op: 'fd-read' }>): Promise<Uint8Array> {
    const file = this.fds.get(req.fd).file;
    const read = req.peek ? file.peek : file.read;
    if (!read) throw new KernelError(req.peek && file.read ? 'EOPNOTSUPP' : 'EBADF');
    if (file.tty) this.checkForeground(file.tty);

    if (req.max <= 0) return new Uint8Array(0);
    const ready = pollFile(file).readable;
    if (!ready && req.nonblock) throw new KernelError('EAGAIN');
    const signal = ready ? this.interrupt.signal : this.blockingSignal();
    return read.call(file, Math.max(0, Math.min(req.max, MAX_READ)), signal);
  }

  private async write(fd: number, body: Uint8Array, nonblock = false): Promise<number> {
    const file = this.fds.get(fd).file;
    if (!file.write) throw new KernelError('EBADF');
    if (!pollFile(file).writable) {
      if (nonblock) throw new KernelError('EAGAIN');
      return file.write(body, this.blockingSignal());
    }

    if (nonblock) return file.write(body, AbortSignal.abort());

    return file.write(
      body,
      this.options.hasPending?.() ? AbortSignal.abort() : this.interrupt.signal
    );
  }

  private async openVfs(req: Extract<FdSyscall, { op: 'fd-open-vfs' }>): Promise<number> {
    await refuseReadonly(this.options.fs, req.path, req.flags, req);
    const fd = this.fds.install(heldFile(), 3);
    try {
      const nodes = this.nodes;
      const path = req.orphan
        ? req.path
        : req.exclusive
          ? await nodes.entryKey(req.path)
          : req.create
            ? await nodes.targetKey(req.path)
            : await this.keptOr(await nodes.targetKey(req.path));
      const open = { ...req, path };
      if (req.exclusive) {
        await nodes.createExclusive(path);
        this.fds.installAt(fd, this.openVfsFile(open));
      } else if (req.create) {
        await nodes.onEntry(path, async () => {
          this.fds.installAt(fd, this.openVfsFile(open));
          await this.fds.get(fd).file.stat?.();
        });
      } else {
        this.fds.installAt(fd, this.openVfsFile(open));
      }
      if (req.existing && !(await present(this.options.fs, path, true))) {
        throw new KernelError('ENOENT');
      }
    } catch (err) {
      await Promise.resolve(this.fds.close(fd));
      throw err;
    }
    return fd;
  }

  private openVfsFile(req: Extract<FdSyscall, { op: 'fd-open-vfs' }>): OpenFile {
    return vfsFile(
      this.options.fs,
      {
        path: req.path,
        flags: req.flags,
        position: req.position,
        ...(req.contents !== undefined ? { contents: req.contents } : {}),
        ...(req.orphan ? { orphan: true } : {}),
        ...(req.truncate ? { truncate: true } : {}),
        ...(req.create ? { create: true } : {}),
        ...(req.pin ? { pin: req.pin } : {}),
      },
      this.nodes
    );
  }

  private async fdSyscall(req: FdSyscall, cancelled?: AbortSignal): Promise<SyncFsResult> {
    if (isVfsSyscall(req)) return this.vfsSyscall(req);
    switch (req.op) {
      case 'fd-read':
        return { ok: true, kind: 'bytes', bytes: await this.read(req) };
      case 'fd-write':
        return { ok: true, kind: 'json', json: await this.write(req.fd, req.body, req.nonblock) };
      case 'fd-close':
        this.options.locks?.closed(this.pid, req.fd);
        await Promise.resolve(this.fds.close(req.fd));
        return { ok: true, kind: 'void' };
      case 'fd-pipe': {
        const pipe = openPipe();
        const read = this.fds.install(pipe.read, 3);
        let write: number;
        try {
          write = this.fds.install(pipe.write, 3);
        } catch (e) {
          await Promise.resolve(this.fds.close(read));
          throw e;
        }
        return { ok: true, kind: 'json', json: [read, write] };
      }
      case 'fd-poll':
        return { ok: true, kind: 'json', json: pollFile(this.fds.get(req.fd).file) };
      case 'fd-open-vfs':
        return { ok: true, kind: 'json', json: await this.openVfs(req) };
      case 'fd-info':
        return { ok: true, kind: 'json', json: this.fdInfo(req.fd) };
      case 'fd-list':
        return {
          ok: true,
          kind: 'json',
          json: this.fds.numbers().map((fd) => ({ fd, ...this.fdInfo(fd) })),
        };
      case 'fd-meta': {
        if (!this.fds.get(req.fd).file.held) throw new KernelError('EBADF');
        const cloexec = this.fds.closesOnExec(req.fd);
        this.fds.installAt(req.fd, heldFile(req.meta));
        if (cloexec) this.fds.setCloseOnExec(req.fd);
        return { ok: true, kind: 'void' };
      }
      case 'fd-setfl':
        this.fds.setStatusFlags(req.fd, req.flags);
        return { ok: true, kind: 'void' };
      case 'fd-cloexec':
        if (req.on) this.fds.setCloseOnExec(req.fd);
        else this.fds.clearCloseOnExec(req.fd);
        return { ok: true, kind: 'void' };
      case 'fd-dup':
        return { ok: true, kind: 'json', json: this.fds.dup(req.fd, req.min ?? 3) };
      case 'fd-reserve':
        return { ok: true, kind: 'json', json: this.reserve(req.fd, req.min, req.meta) };
      case 'fd-promote':
        await this.promote(req);
        return { ok: true, kind: 'void' };
      case 'fd-renumber':
        if (req.from !== req.to) {
          this.fds.dup2(req.from, req.to);
          if (!req.keep) await Promise.resolve(this.fds.close(req.from));
        }
        return { ok: true, kind: 'void' };
      case 'fd-open-tty': {
        const tty =
          req.name === undefined
            ? this.controllingTerminal()
            : this.options.jobs?.terminalNamed(req.name);
        if (!tty) throw new KernelError('ENXIO');
        return { ok: true, kind: 'json', json: this.fds.install(tty.file(), 3) };
      }
      case 'fd-tty-names':
        return { ok: true, kind: 'json', json: this.options.jobs?.terminalNames() ?? [] };
      case 'fd-select': {
        const { read, write, timeoutMs } = req;
        const blocking = this.blockingSignal();
        const signal = cancelled ? AbortSignal.any([blocking, cancelled]) : blocking;
        const selected = await selectFds(this.fds, read, write, timeoutMs, signal);
        return { ok: true, kind: 'json', json: selected };
      }
      case 'fd-seek': {
        const file = this.fds.get(req.fd).file;
        if (!file.seek) throw new KernelError('ESPIPE');
        return { ok: true, kind: 'json', json: await file.seek(req.offset, req.whence) };
      }
      case 'fd-flush': {
        const file = this.fds.get(req.fd).file;
        if (file.flush) await file.flush();
        return { ok: true, kind: 'void' };
      }
    }
  }

  private async vfsSyscall(req: VfsSyscall): Promise<SyncFsResult> {
    if ('path' in req || 'from' in req) {
      const nodes = this.nodes;
      if (req.op === 'fd-path-flush') {
        await nodes.flush(await nodes.targetKey(req.path).catch(() => req.path));
      } else if (req.op === 'fd-path-unlinking')
        await nodes.unlinking(await nodes.entryKey(req.path));
      else if (req.op === 'fd-path-unlinked') nodes.unlinked(await nodes.entryKey(req.path));
      else if (req.op === 'fd-path-renamed') {
        nodes.renamed(await nodes.entryKey(req.from), await nodes.entryKey(req.to));
      }
      return { ok: true, kind: 'void' };
    }
    const file = this.fds.get(req.fd).file;
    if (!file.pread || !file.pwrite || !file.resize || !file.stat) throw new KernelError('ESPIPE');
    switch (req.op) {
      case 'fd-pread':
        return {
          ok: true,
          kind: 'bytes',
          bytes: await file.pread(Math.min(req.max, MAX_READ), req.offset),
        };
      case 'fd-pwrite':
        return { ok: true, kind: 'json', json: await file.pwrite(req.body, req.offset) };
      case 'fd-resize':
        await file.resize(req.size);
        return { ok: true, kind: 'void' };
      case 'fd-vfs-stat':
        return { ok: true, kind: 'json', json: await file.stat() };
    }
  }

  keptPath?: (path: string) => string | undefined;

  private async keptOr(path: string): Promise<string> {
    const kept = this.keptPath?.(path);
    return kept !== undefined && !(await present(this.options.fs, path, true)) ? kept : path;
  }

  private async promote(req: Extract<WasmSyscall, { op: 'fd-promote' }>): Promise<void> {
    if (!this.fds.get(req.fd).file.held) throw new KernelError('EBADF');
    if (req.share !== undefined) {
      this.fds.dup2(req.share, req.fd);
      return;
    }
    if (req.path === undefined) throw new KernelError('EINVAL');
    const path = req.orphan ? req.path : await this.keptOr(await this.nodes.targetKey(req.path));
    if (!this.fds.get(req.fd).file.held) throw new KernelError('EBADF');
    const file = vfsFile(
      this.options.fs,
      {
        path,
        flags: req.flags ?? 0,
        position: req.position ?? 0,
        ...(req.contents !== undefined ? { contents: req.contents } : {}),
        ...(req.orphan ? { orphan: true } : {}),
        ...(req.dirty ? { dirty: true } : {}),
        ...(req.pin ? { pin: req.pin } : {}),
      },
      this.nodes
    );
    this.fds.installAt(req.fd, file);
  }

  private reserve(fd: number | undefined, min = 3, meta?: HeldMeta): number {
    if (fd === undefined) return this.fds.install(heldFile(meta), Math.max(3, min));
    if (this.fds.has(fd)) throw new KernelError('EBADF');
    this.fds.installAt(fd, heldFile(meta));
    return fd;
  }

  private fdInfo(fd: number): FdInfo {
    const file = this.fds.get(fd).file;
    const flags = this.fds.statusFlags(fd);
    return {
      tty: file.tty !== undefined,
      kind: file instanceof KernelSocket ? 'socket' : kernelFdKind(file),
      ...(file.heldMeta ? { meta: file.heldMeta } : {}),
      ...(flags !== undefined ? { flags } : {}),
      ...(this.fds.closesOnExec(fd) ? { cloexec: true } : {}),
      ...(file.tty?.name ? { name: file.tty.name } : file.pty ? { name: '/dev/ptmx' } : {}),
    };
  }

  private ttySyscall(req: TtySyscall): SyncFsResult {
    const tty = this.tty(req.fd);
    const jobs = this.options.jobs;
    switch (req.op) {
      case 'tty-get':
        return { ok: true, kind: 'json', json: tty.tcgets() };
      case 'tty-set':
        tty.tcsets(req.termios);
        return { ok: true, kind: 'void' };
      case 'tty-winsz':
        return { ok: true, kind: 'json', json: tty.winsize() };
      case 'tty-pgrp-get':
        return { ok: true, kind: 'json', json: jobs ? jobs.tcgetpgrp(tty, this.sid()) : this.pid };
      case 'tty-pgrp-set':
        if (jobs) jobs.tcsetpgrp(this.pid, tty, req.pgrp);
        else if (req.pgrp !== this.pid) throw new KernelError('EPERM');
        return { ok: true, kind: 'void' };
    }
  }

  private checkForeground(tty: KernelTty): void {
    const jobs = this.options.jobs;
    if (!jobs) return;
    const session = jobs.controllingTerminal(this.pid);
    if (session !== undefined && session !== tty) return;
    const pgid = this.pgid();
    if (jobs.tcgetpgrp(tty, this.sid()) === pgid) return;
    if (this.ignores(sigbit(SIG.TTIN))) throw new KernelError('EIO');
    jobs.killGroup(pgid, SIG.TTIN);
    throw new KernelError('EINTR');
  }

  private waitGroup(pid: number): ((child: number) => boolean) | undefined {
    const jobs = this.options.jobs;
    if (!jobs || pid > 0 || pid === -1) return undefined;
    const group = pid === 0 ? this.pgid() : -pid;

    return (child) => (jobs.pgidOf(child) ?? this.pgid()) === group;
  }

  private pgid(): number {
    return this.options.jobs?.getpgid(this.pid, 0) ?? this.pid;
  }

  private sid(): number {
    return this.options.jobs?.getsid(this.pid, 0) ?? this.pid;
  }

  private controllingTerminal(): KernelTty | undefined {
    const session = this.options.jobs?.controllingTerminal(this.pid);
    return session === undefined ? this.fds.stdioTerminal() : (session ?? undefined);
  }

  private jobSyscall(req: JobSyscall): SyncFsResult {
    const jobs = this.options.jobs;
    const self = (pid: number): number => {
      if (pid !== 0 && pid !== this.pid) throw new KernelError('ESRCH');
      return this.pid;
    };
    switch (req.op) {
      case 'proc-setpgid':
        if (jobs) jobs.setpgid(this.pid, req.pid, req.pgid);
        else if (self(req.pid) !== (req.pgid || this.pid)) throw new KernelError('EPERM');
        return { ok: true, kind: 'void' };
      case 'proc-getpgid':
        return { ok: true, kind: 'json', json: jobs?.getpgid(this.pid, req.pid) ?? self(req.pid) };
      case 'proc-getsid':
        return { ok: true, kind: 'json', json: jobs?.getsid(this.pid, req.pid) ?? self(req.pid) };
      case 'proc-setsid':
        if (!jobs) throw new KernelError('EPERM');
        return { ok: true, kind: 'json', json: jobs.setsid(this.pid) };
    }
  }

  private httpSyscall(req: HttpSyscall): Promise<SyncFsResult> {
    const http = this.options.http;
    if (!http) return Promise.resolve({ ok: false, errno: 'ENETUNREACH', message: NO_TRANSPORT });
    return http.syscall(req);
  }

  private socketSyscall(req: SocketSyscall): Promise<SyncFsResult> {
    this.net ??= this.options.net ?? new LoopbackNet();
    const resolver = this.options.resolver ?? HOSTS_ONLY;
    return socketSyscall(req, {
      fds: this.fds,
      net: this.net,
      blocking: () => this.blockingSignal(),
      resolve: (name, family, blocking) => resolver.resolve(name, family, blocking),
    });
  }

  private tty(fd: number): KernelTty {
    const file = this.fds.get(fd).file;
    const tty = file.tty ?? file.pty?.slave;
    if (!tty) throw new KernelError('ENOTTY');
    return tty;
  }

  private async procSyscall(
    req: Exclude<
      WasmSyscall,
      FdSyscall | TtySyscall | JobSyscall | SocketSyscall | HttpSyscall | PtySyscall | HostSyscall
    >
  ): Promise<SyncFsResult> {
    switch (req.op) {
      case 'proc-fork':
        return { ok: true, kind: 'json', json: await this.children.fork(req.state) };
      case 'proc-spawn': {
        const { file, argv, env, cwd, stdio, inherit, exec } = req;
        const spawned = { file, argv, env, cwd, ...(exec ? { exec } : {}) };
        const pid = await this.children.spawn(spawned, stdio, inherit);
        return { ok: true, kind: 'json', json: pid };
      }
      case 'proc-wait': {
        const signal = req.nohang ? this.interrupt.signal : this.blockingSignal();
        const flags = {
          untraced: req.untraced,
          continued: req.continued,
          inGroup: this.waitGroup(req.pid),
        };
        const waited = await this.children.wait(req.pid, req.nohang, signal, flags);
        return { ok: true, kind: 'json', json: waited };
      }
      case 'proc-identity':
        return { ok: true, kind: 'json', json: (await this.options.identity?.()) ?? null };
      case 'proc-exec': {
        this.execChild = req.pid;
        this.options.jobs?.exec(this.pid, req.pid);

        this.children.watch(req.pid, (state, sig) =>
          state === 'stopped' ? this.stop(sig) : this.cont()
        );

        await this.fds.closeAll();
        try {
          const waited = await this.children.wait(req.pid, false);
          const termsig = waited[1] & 0x7f;
          if (termsig) this.execTermsig = termsig;
          return { ok: true, kind: 'json', json: waited };
        } finally {
          this.execChild = undefined;
        }
      }
      case 'proc-kill':
        if (req.sig !== 0 && !isSignal(req.sig)) throw new KernelError('EINVAL');

        if (!(await this.options.kill?.(req.pid === 0 ? -this.pgid() : req.pid, req.sig))) {
          throw new KernelError('ESRCH');
        }
        return { ok: true, kind: 'void' };
      case 'proc-list':
        return {
          ok: true,
          kind: 'json',
          json: this.options.processes?.() ?? { boot: 0, processes: [] },
        };
      case 'mount-list':
        return { ok: true, kind: 'json', json: this.options.mounts?.() ?? [] };
      case 'mount':
      case 'umount':
        return this.mountSyscall(req);
      case 'proc-alarm':
        this.setAlarm(req.sig, req.firstMs ?? req.ms, req.repeat ? req.ms : 0, req.timer);
        return { ok: true, kind: 'void' };
      case 'proc-umask':
        return { ok: true, kind: 'json', json: this.setUmask(req.mask) };
      case 'dl-log':
        if (req.append) this.dlLog.push(req.append);
        return { ok: true, kind: 'json', json: this.dlLog.slice(req.from) };
      case 'sig-mask':
        this.caught = req.caught;
        this.ignored = req.ignored;
        this.inherited &= ~(req.defaults ?? 0);
        return { ok: true, kind: 'void' };
      case 'sig-pause':
        return this.pause();
      case 'proc-captured':
        return { ok: true, kind: 'bytes', bytes: this.children.captured(req.pid, req.slot) };
    }
  }

  private async mountSyscall(
    req: Extract<WasmSyscall, { op: 'mount' | 'umount' }>
  ): Promise<SyncFsResult> {
    const { mount, umount } = this.options;
    if (!mount || !umount) throw new KernelError('ENOSYS');
    try {
      if (req.op === 'umount') await umount(req.target, req.flags);
      else {
        const { source, target, type, flags, data } = req;
        const signal = this.blockingSignal();
        await Promise.race([mount({ source, target, type, flags, data }, signal), aborted(signal)]);
      }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== 'string') throw err;
      return { ok: false, errno: code, message: (err as Error).message };
    }
    return { ok: true, kind: 'void' };
  }

  private pause(): Promise<never> {
    return aborted(this.blockingSignal());
  }

  private alarm: ReturnType<typeof setTimeout> | undefined;
  private readonly dlLog: LinkRecord[] = [];
  private readonly asyncOps = new AsyncOps(
    (req, cancelled) => this.syscall(req as WasmSyscall, cancelled),
    () => this.options.onAsync?.()
  );
  private alarmEvery: ReturnType<typeof setInterval> | undefined;

  private setAlarm(sig: number, first: number, every: number, timer?: number): void {
    if (!isSignal(sig)) throw new KernelError('EINVAL');
    this.clearAlarm();
    if (first <= 0) return;
    const fire =
      timer === undefined ? () => this.options.raise?.(sig) : () => this.timerExpired(timer);
    this.alarm = setTimeout(() => {
      this.alarm = undefined;
      fire();
      if (every > 0) this.alarmEvery = setInterval(fire, every);
    }, first);
  }

  private timerExpired(which: number): void {
    this.options.onTimer?.(which);
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
  }

  private clearAlarm(): void {
    clearTimeout(this.alarm);
    clearInterval(this.alarmEvery);
    this.alarm = undefined;
    this.alarmEvery = undefined;
  }

  async exit(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    this.die();
    this.clearAlarm();
    this.interrupt.abort();
    this.options.locks?.release(this.pid);
    this.asyncOps.close();
    for (const pid of this.children.pids()) this.options.onReap?.(pid);
    await this.fds.closeAll();
    if (!this.options.nodes) this.options.openFiles?.delete(this.nodes);
    await this.options.http?.closeAll();
  }
}
