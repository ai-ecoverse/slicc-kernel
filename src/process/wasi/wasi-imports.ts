import type { SyncFsPosixBridge, SyncFsResult } from '../../realm/sync-fs-wire.ts';
import { E, FDFLAGS, OFLAGS, RIGHTS, wasiErrnoOf } from './wasi-abi.ts';
import { WasiError } from './wasi-files.ts';
import type { WasiHost } from './wasi-host.ts';

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

export async function loadImports(source: string): Promise<CreateImports> {
  const loaded = (await import(`data:text/javascript;base64,${base64(source)}`)) as {
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
  const locked = new Map<number, string>();
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
  const unlock = (fd: number) => {
    const path = locked.get(fd);
    if (path === undefined) return;
    locked.delete(fd);
    if (![...locked.values()].includes(path)) call({ op: 'unlock', path });
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
      unlock(fd);
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
        call({ op: 'lock', path, exclusive });
      } catch (err) {
        if (code(err) === 'EAGAIN') return E.AGAIN;
        throw err;
      }
      locked.set(fd, path);
      return E.SUCCESS;
    },
    unlock,
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
