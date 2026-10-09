import type { DeviceMeta, KernelFdKind } from '../../kernel/fd-table.ts';
import { SIG } from '../../kernel/signals.ts';
import { parseSyncFsStat, type SyncFsBridgeStat } from '../../realm/sync-fs-wire.ts';
import { JsCallError, type JsKernel } from './js-kernel.ts';

export interface JsOpenOptions {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  create?: boolean;
  exclusive?: boolean;
  truncate?: boolean;
}

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

export type JsFdType = 'file' | 'pipe' | 'tty' | 'socket' | 'device' | 'directory';

export interface JsFdStatus {
  type: JsFdType;
  tty: boolean;
  seekable: boolean;
}

export type JsSignal = number | `SIG${string}`;

export interface JsProgramContext {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly pid: number;
  readonly cwd: string;
  readonly stdin: ReadableStream<Uint8Array>;
  readonly stdout: WritableStream<Uint8Array>;
  readonly stderr: WritableStream<Uint8Array>;
  read(fd: number, max?: number): Promise<Uint8Array>;
  write(fd: number, data: Uint8Array | string): Promise<void>;
  close(fd: number): Promise<void>;
  fdStatus(fd: number): Promise<JsFdStatus>;
  isatty(fd: number): Promise<boolean>;
  open(path: string, options?: JsOpenOptions): Promise<JsFile>;
  resolve(path: string): string;
  fs: {
    stat(path: string): Promise<SyncFsBridgeStat>;
    lstat(path: string): Promise<SyncFsBridgeStat>;
    exists(path: string): Promise<boolean>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rm(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
  };
  signals: {
    on(signal: JsSignal, handler: (signal: number) => void): Promise<void>;
    ignore(signal: JsSignal): Promise<void>;
    reset(signal: JsSignal): Promise<void>;
  };
  exit(code?: number): never;
}

export class JsExit extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`exit ${status}`);
    this.name = 'JsExit';
    this.status = status;
  }
}

interface FdInfo {
  tty?: boolean;
  kind?: KernelFdKind;
  meta?: DeviceMeta | { dir: string };
}

export interface ContextOptions {
  kernel: JsKernel;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  pid: number;
  cwd: string;
  exit(status: number): void;
  random?: (bytes: Uint8Array) => void;
}

const CHUNK = 64 * 1024;
const MAX_IO = 1024 * 1024;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;
const encoder = new TextEncoder();

export function signalNumber(signal: JsSignal): number {
  if (typeof signal === 'number') {
    if (Number.isInteger(signal) && signal >= 1 && signal <= 31) return signal;
    throw new JsCallError('EINVAL', `signal ${signal}`);
  }
  const n = (SIG as Record<string, number>)[signal.slice(3)];
  if (n === undefined) throw new JsCallError('EINVAL', `signal ${signal}`);
  return n;
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

function typeOf(info: FdInfo): JsFdType {
  if (info.meta && 'dir' in info.meta) return 'directory';
  if (info.meta && 'device' in info.meta) return 'device';
  if (info.tty || info.kind === 'tty') return 'tty';
  if (info.kind === 'socket') return 'socket';
  return info.kind === 'file' ? 'file' : 'pipe';
}

function flagsOf(o: JsOpenOptions): number {
  const write = o.write || o.append || o.truncate;
  const access = write ? (o.read ? O_RDWR : O_WRONLY) : 0;
  return access | (o.append ? O_APPEND : 0);
}

export interface CreatedContext {
  ctx: JsProgramContext;
  drain(): Promise<unknown>;
}

export function createContext(o: ContextOptions): CreatedContext {
  const { kernel } = o;
  const infos = new Map<number, FdInfo>();
  const pending = new Set<Promise<unknown>>();
  const random =
    o.random ??
    ((bytes: Uint8Array) => void crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>));
  const resolve = (path: string) => resolvePath(o.cwd, path);
  const exit = (code = 0): never => {
    o.exit(code);
    throw new JsExit(code);
  };

  const info = async (fd: number): Promise<FdInfo> => {
    const known = infos.get(fd);
    if (known) return known;
    const got = (await kernel.json({ op: 'fd-info', fd })) as FdInfo;
    infos.set(fd, got);
    return got;
  };
  const device = (i: FdInfo): DeviceMeta | undefined =>
    i.meta && 'device' in i.meta ? i.meta : undefined;

  const read = async (fd: number, max = CHUNK): Promise<Uint8Array> => {
    const i = await info(fd);
    if (typeOf(i) === 'directory') throw new JsCallError('EISDIR', 'read');
    const dev = device(i);
    if (dev) {
      if (dev.access === 'write') throw new JsCallError('EBADF', 'read');
      if (dev.device === 'null') return new Uint8Array(0);
      const out = new Uint8Array(Math.min(max, CHUNK));
      if (dev.device === 'urandom') random(out);
      return out;
    }
    const r = await kernel.blocking({ op: 'fd-read', fd, max: Math.min(max, MAX_IO) });
    return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
  };

  const writeAll = async (fd: number, data: Uint8Array): Promise<void> => {
    const i = await info(fd);
    if (typeOf(i) === 'directory') throw new JsCallError('EISDIR', 'write');
    const dev = device(i);
    if (dev) {
      if (dev.access === 'read') throw new JsCallError('EBADF', 'write');
      return;
    }
    let at = 0;
    while (at < data.length) {
      const body = data.subarray(at, at + MAX_IO);
      try {
        const r = await kernel.blocking({ op: 'fd-write', fd, body });
        at += r.ok && r.kind === 'json' && typeof r.json === 'number' ? r.json : body.length;
      } catch (err) {
        const broken = err instanceof JsCallError && err.code === 'EPIPE';
        if (broken && typeOf(i) !== 'socket' && !kernel.handles(SIG.PIPE)) exit(128 + SIG.PIPE);
        throw err;
      }
    }
  };

  const write = (fd: number, data: Uint8Array | string): Promise<void> => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const run = writeAll(fd, bytes);
    pending.add(run);
    const forget = () => void pending.delete(run);
    run.then(forget, forget);
    return run;
  };

  const writable = (fd: number) =>
    new WritableStream<Uint8Array>({ write: (chunk) => write(fd, chunk) });

  const statOf = async (op: 'stat' | 'lstat', path: string): Promise<SyncFsBridgeStat> => {
    const abs = resolve(path);
    await kernel.call({ op: 'fd-path-flush', path: abs });
    const s = parseSyncFsStat(await kernel.json({ op, path: abs }));
    if (!s) throw new JsCallError('EIO', op);
    return s;
  };

  const open = async (path: string, options: JsOpenOptions = {}): Promise<JsFile> => {
    const abs = resolve(path);
    const existing = await statOf('stat', abs).catch((err: unknown) => {
      if (err instanceof JsCallError && err.code === 'ENOENT') return undefined;
      throw err;
    });
    const exclusive = options.create === true && options.exclusive === true;
    if (existing && exclusive) throw new JsCallError('EEXIST', abs);
    if (!existing && !options.create) throw new JsCallError('ENOENT', abs);
    if (existing?.isDirectory) throw new JsCallError('EISDIR', abs);
    const fd = (await kernel.json({
      op: 'fd-open-vfs',
      path: abs,
      flags: flagsOf(options),
      position: 0,
      ...(exclusive ? { exclusive: true } : existing ? {} : { create: true }),
      ...(options.truncate ? { truncate: true } : {}),
    })) as number;
    try {
      await kernel.call({ op: 'fd-vfs-stat', fd });
    } catch (err) {
      await kernel.raw({ op: 'fd-close', fd });
      throw err;
    }
    infos.set(fd, { kind: 'file' });
    return fileHandle(kernel, fd, abs, options.append === true, () => infos.delete(fd));
  };

  const fs: JsProgramContext['fs'] = {
    stat: (path) => statOf('stat', path),
    lstat: (path) => statOf('lstat', path),
    exists: async (path) => (await kernel.json({ op: 'exists', path: resolve(path) })) === true,
    readdir: async (path) =>
      (await kernel.json({ op: 'readdir', path: resolve(path) })) as string[],
    mkdir: async (path) => void (await kernel.call({ op: 'mkdir', path: resolve(path) })),
    rm: async (path) => void (await kernel.call({ op: 'rm', path: resolve(path) })),
    unlink: async (path) => void (await kernel.call({ op: 'unlink', path: resolve(path) })),
    rename: async (from, to) =>
      void (await kernel.call({ op: 'rename', path: resolve(from), arg2: resolve(to) })),
    symlink: async (target, path) =>
      void (await kernel.call({ op: 'symlink', path: resolve(path), arg2: target })),
    readlink: async (path) => String(await kernel.json({ op: 'readlink', path: resolve(path) })),
    async readFile(path) {
      const abs = resolve(path);
      await kernel.call({ op: 'fd-path-flush', path: abs });
      return kernel.bytes({ op: 'read', path: abs });
    },
    async writeFile(path, data) {
      const file = await open(path, { write: true, create: true, truncate: true });
      try {
        await file.write(0, typeof data === 'string' ? encoder.encode(data) : data);
      } finally {
        await file.close();
      }
    },
  };

  const ctx: JsProgramContext = {
    argv: o.argv,
    env: o.env,
    pid: o.pid,
    cwd: o.cwd,
    stdin: new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const chunk = await read(0);
          if (chunk.length === 0) controller.close();
          else controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 }
    ),
    stdout: writable(1),
    stderr: writable(2),
    read,
    write,
    async close(fd) {
      infos.delete(fd);
      await kernel.call({ op: 'fd-close', fd });
    },
    async fdStatus(fd) {
      const type = typeOf(await info(fd));
      return { type, tty: type === 'tty', seekable: type === 'file' };
    },
    isatty: async (fd) => typeOf(await info(fd)) === 'tty',
    open,
    resolve,
    fs,
    signals: {
      on: async (signal, handler) => kernel.setHandler(signalNumber(signal), handler),
      ignore: async (signal) => kernel.setHandler(signalNumber(signal), 'ignore'),
      reset: async (signal) => kernel.setHandler(signalNumber(signal), 'default'),
    },
    exit,
  };
  return { ctx, drain: () => Promise.allSettled([...pending]) };
}

function fileHandle(
  kernel: JsKernel,
  fd: number,
  path: string,
  append: boolean,
  forget: () => void
): JsFile {
  return {
    fd,
    path,
    async size() {
      const s = (await kernel.json({ op: 'fd-vfs-stat', fd })) as { size: number };
      return s.size;
    },
    async read(position, length) {
      const parts: Uint8Array[] = [];
      let got = 0;
      while (got < length) {
        const max = Math.min(length - got, MAX_IO);
        const chunk = await kernel.bytes({ op: 'fd-pread', fd, offset: position + got, max });
        if (chunk.length === 0) break;
        parts.push(chunk);
        got += chunk.length;
      }
      if (parts.length === 1) return parts[0] as Uint8Array;
      const out = new Uint8Array(got);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    },
    async write(position, data) {
      let at = 0;
      while (at < data.length) {
        const body = data.subarray(at, at + MAX_IO);
        const n = (await kernel.json(
          append
            ? { op: 'fd-write', fd, body }
            : { op: 'fd-pwrite', fd, offset: position + at, body }
        )) as number;
        if (!(n > 0)) throw new JsCallError('EIO', 'write');
        at += n;
      }
      return at;
    },
    async truncate(size) {
      await kernel.call({ op: 'fd-resize', fd, size });
    },
    async sync() {
      await kernel.call({ op: 'fd-flush', fd });
    },
    async close() {
      forget();
      await kernel.call({ op: 'fd-close', fd });
    },
  };
}
