import type { SyncFsPosixBridge, SyncFsResult } from '../../realm/sync-fs-wire.ts';
import { E, FDFLAGS, OFLAGS, RIGHTS, wasiErrnoOf } from './wasi-abi.ts';
import { WasiError } from './wasi-files.ts';
import type { WasiHost } from './wasi-host.ts';
import { MAIN_TID } from './wasi-threads.ts';
import { restarted } from './wasix-process.ts';

export interface Request {
  op: string;
  [key: string]: unknown;
}

export type Raw = (req: Request) => SyncFsResult;

export interface OpenOptions {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  create?: boolean;
  exclusive?: boolean;
  truncate?: boolean;
  directory?: boolean;
  nofollow?: boolean;
  mode?: number;
}

export interface FdStat {
  kind: 'file' | 'dir' | 'device' | 'stream';
  path?: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  ino?: number;
  mtimeMs?: number;
}

export type Taken = { value: unknown } | { error: string };

export type Stdio = 'pipe' | 'inherit' | 'null';

export interface SpawnOptions {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
}

export interface Spawned {
  pid: number;
  stdin?: number;
  stdout?: number;
  stderr?: number;
}

export interface Waited {
  status: number;
  signal?: number;
}

export interface ImportsContext {
  memory(): WebAssembly.Memory;
  instance(): WebAssembly.Instance | undefined;
  tid: number;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd(): string;
  fs: SyncFsPosixBridge;
  fds: {
    open(path: string, options?: OpenOptions): number;
    close(fd: number): void;
    fstat(fd: number): FdStat;
    fchmod(fd: number, mode: number): void;
    tryLock(fd: number, exclusive: boolean): number;
    unlock(fd: number): void;
  };
  syscall(req: Request): unknown;
  spawn(options: SpawnOptions): Spawned;
  wait(pid: number): Waited;
  kill(pid: number, sig: number): void;
  async: {
    submit(req: Request): number;
    wait(timeoutMs?: number): number;
    take(id: number): Taken | undefined;
    resolve(value: unknown): number;
    hold(): number;
    cancel(id: number): void;
    close(): void;
  };
  errno(err: unknown): number;
}

export type ProgramImports = Record<string, Record<string, WebAssembly.ImportValue>>;

export type CreateImports = (ctx: ImportsContext) => ProgramImports;

const UID = 1000;

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function importSource(source: string): Promise<Record<string, unknown>> {
  return import(`data:text/javascript;base64,${base64(source)}`);
}

export async function loadImports(source: string): Promise<CreateImports> {
  const loaded = (await importSource(source)) as {
    createImports?: unknown;
  };
  if (typeof loaded.createImports !== 'function') {
    throw new Error('the imports module exports no createImports function');
  }
  return loaded.createImports as CreateImports;
}

function value(result: SyncFsResult): unknown {
  if (!result.ok) throw new WasiError(result.errno);
  if (result.kind === 'json') return result.json;
  return result.kind === 'bytes' ? result.bytes : undefined;
}

function code(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

export interface ContextOptions {
  host: WasiHost;
  raw: Raw;
  tid: number;
  memory: () => WebAssembly.Memory;
  instance: () => WebAssembly.Instance | undefined;
}

export function importsContext({
  host,
  raw,
  tid,
  memory,
  instance,
}: ContextOptions): ImportsContext {
  const { fs } = host.o;
  const call = (req: Request) => value(raw(req));
  const pathOf = (fd: number): string | undefined => {
    const e = host.fds.get(fd);
    if (e.type === 'file') return e.file.path;
    if (e.type === 'dir') return e.path;
    if (e.type === 'kernel' && host.fds.kind(fd, e) === 'file') {
      return (call({ op: 'fd-vfs-stat', fd }) as { path?: string }).path;
    }
    return undefined;
  };
  const requirePath = (fd: number): string => {
    const path = pathOf(fd);
    if (path === undefined) throw new WasiError('EBADF');
    return path;
  };
  const fds: ImportsContext['fds'] = {
    open(path, o = {}) {
      const abs = host.fds.resolve(3, path);
      if (o.nofollow && fs.exists(abs) && fs.lstat(abs).isSymbolicLink)
        throw new WasiError('ELOOP');
      const existed = fs.exists(abs);
      const oflags =
        (o.create ? OFLAGS.CREAT : 0) |
        (o.exclusive ? OFLAGS.EXCL : 0) |
        (o.truncate ? OFLAGS.TRUNC : 0) |
        (o.directory ? OFLAGS.DIRECTORY : 0);
      const rights = (o.write ? RIGHTS.FD_WRITE : 0n) | (o.read || !o.write ? RIGHTS.FD_READ : 0n);
      const fd = host.fds.open(abs, oflags, rights, o.append ? FDFLAGS.APPEND : 0);
      if (o.mode !== undefined && !existed) fs.chmod(abs, o.mode);
      return fd;
    },
    close(fd) {
      host.fds.close(fd);
    },
    fstat(fd) {
      const e = host.fds.get(fd);
      const path = pathOf(fd);
      if (path === undefined) {
        const kind = e.type === 'device' ? 'device' : 'stream';
        return { kind, mode: kind === 'device' ? 0o20666 : 0o10600, uid: UID, gid: UID, size: 0 };
      }
      host.fds.flushPath(path);
      const s = fs.stat(path);
      return {
        kind: s.isDirectory ? 'dir' : 'file',
        path,
        mode: s.mode ?? (s.isDirectory ? 0o40755 : 0o100644),
        uid: UID,
        gid: UID,
        size: s.size,
        ...(s.ino !== undefined ? { ino: s.ino } : {}),
        ...(s.mtimeMs !== undefined ? { mtimeMs: s.mtimeMs } : {}),
      };
    },
    fchmod(fd, mode) {
      fs.chmod(requirePath(fd), mode);
    },
    tryLock(fd, exclusive) {
      const path = requirePath(fd);
      try {
        call({ op: 'lock', path, exclusive, fd });
      } catch (err) {
        if (code(err) === 'EAGAIN') return E.AGAIN;
        throw err;
      }
      return E.SUCCESS;
    },
    unlock(fd) {
      call({ op: 'unlock', path: requirePath(fd) });
    },
  };
  return {
    memory,
    instance,
    tid,
    argv: host.o.args,
    env: host.o.env,
    cwd: () => host.cwd,
    fs,
    fds,
    syscall: call,
    ...processes(host, call, tid !== MAIN_TID),
    async: {
      submit: (req) => call({ op: 'async-submit', req }) as number,
      wait(timeoutMs) {
        for (;;) {
          try {
            return call({
              op: 'async-wait',
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            }) as number;
          } catch (err) {
            if (code(err) !== 'EINTR') throw err;
            if (timeoutMs !== undefined) return 0;
          }
        }
      },
      take(id) {
        const result = raw({ op: 'async-take', id });
        if (!result.ok && result.errno === 'EAGAIN') return undefined;
        if (!result.ok) return { error: result.errno };
        return { value: value(result) };
      },
      resolve: (v) => call({ op: 'async-resolve', value: v }) as number,
      hold: () => call({ op: 'async-hold' }) as number,
      cancel: (id) => void raw({ op: 'async-cancel', id }),
      close: () => void call({ op: 'async-close' }),
    },
    errno: (err) => wasiErrnoOf(code(err)),
  };
}

type ChildSlot = { fd: number } | { none: true };

const STDIO = ['stdin', 'stdout', 'stderr'] as const;

function processes(
  host: WasiHost,
  call: (req: Request) => unknown,
  inThread: boolean
): Pick<ImportsContext, 'spawn' | 'wait' | 'kill'> {
  const close = (fd: number) => void call({ op: 'fd-close', fd });
  const slot = (n: number, how: Stdio, mine: number[], theirs: number[]): ChildSlot => {
    if (how === 'inherit') return { fd: n };
    if (how === 'null') return { none: true };
    const [read, write] = call({ op: 'fd-pipe' }) as [number, number];
    mine[n] = n === 0 ? write : read;
    theirs.push(n === 0 ? read : write);
    return { fd: n === 0 ? read : write };
  };
  return {
    spawn(o) {
      const mine: number[] = [];
      const theirs: number[] = [];
      host.fds.promoteFiles();
      try {
        const stdio = STDIO.map((name, n) => slot(n, o[name] ?? 'inherit', mine, theirs));
        const req = {
          op: 'proc-spawn' as const,
          file: o.argv[0],
          argv: o.argv,
          env: o.env ?? { ...host.o.env },
          cwd: o.cwd ?? host.cwd,
          stdio,
          ...(inThread ? {} : { restart: true as const }),
        };
        const pid = restarted(() => call(req)) as number;
        const out: Spawned = { pid };
        STDIO.forEach((name, n) => {
          if (mine[n] !== undefined) out[name] = mine[n];
        });
        return out;
      } catch (err) {
        for (const fd of mine) if (fd !== undefined) close(fd);
        throw err;
      } finally {
        for (const fd of theirs) close(fd);
        host.o.fs.invalidate?.();
      }
    },
    wait(pid) {
      for (;;) {
        try {
          const [, status] = call({ op: 'proc-wait', pid, nohang: false }) as [number, number];
          host.o.fs.invalidate?.();
          const signal = status & 0x7f;
          return signal ? { status: 128 + signal, signal } : { status: (status >> 8) & 0xff };
        } catch (err) {
          if (code(err) !== 'EINTR') throw err;
        }
      }
    },
    kill(pid, sig) {
      call({ op: 'proc-kill', pid, sig });
    },
  };
}
