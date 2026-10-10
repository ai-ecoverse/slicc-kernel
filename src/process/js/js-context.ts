import { SIG } from '../../kernel/signals.ts';
import { parseSyncFsStat, type SyncFsBridgeStat } from '../../realm/sync-fs-wire.ts';
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
  joined,
  MAX_IO,
  openRequest,
  readDevice,
  typeOf,
  writeDevice,
  written,
} from './js-io.ts';
import { JsCallError, type JsKernel } from './js-kernel.ts';
import { type JsSyncContext, JsSyncKernel, laneOf, type SyncCall, syncOps } from './js-sync.ts';

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

export interface JsProgramContext {
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
  sync: JsSyncContext;
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

export interface CreatedContext {
  ctx: JsProgramContext;
  drain(): Promise<unknown>;
}

export function createContext(o: ContextOptions): CreatedContext {
  const { kernel } = o;
  const infos = new Map<number, FdInfo>();
  const handles = new Map<number, () => void>();
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
  const read = async (fd: number, max = CHUNK): Promise<Uint8Array> => {
    index(max, 'read');
    const emulated = readDevice(await info(fd), max, random);
    if (emulated) return emulated;
    const r = await kernel.blocking({ op: 'fd-read', fd, max: Math.min(max, MAX_IO) });
    return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
  };

  const writeAll = async (fd: number, data: Uint8Array): Promise<void> => {
    const i = await info(fd);
    if (writeDevice(i)) return;
    let at = 0;
    while (at < data.length) {
      const body = data.subarray(at, at + MAX_IO);
      try {
        const r = await kernel.blocking({ op: 'fd-write', fd, body });
        at += written(r, body.length);
      } catch (err) {
        if (brokenPipe(err, i)) await kernel.call({ op: 'proc-kill', pid: o.pid, sig: SIG.PIPE });
        throw err;
      }
    }
  };

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
    await kernel.call({ op: 'fd-path-flush', path: abs });
    const s = parseSyncFsStat(await kernel.json({ op, path: abs }));
    if (!s) throw new JsCallError('EIO', op);
    return s;
  };

  const open = async (path: string, options: JsOpenOptions = {}): Promise<JsFile> => {
    const abs = resolve(path);
    const existing = await statOf(isExclusive(options) ? 'lstat' : 'stat', abs).catch(absent);
    checkOpen(abs, options, existing);
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
  };

  const fs = pathOps(kernel, resolve, statOf, open);
  const sync = syncOps(new JsSyncKernel(o.lane ?? laneOf(undefined), kernel), {
    pid: o.pid,
    resolve,
    random,
    infos,
    handles,
  });

  const ctx: JsProgramContext = {
    argv: o.argv,
    env: o.env,
    pid: o.pid,
    async ppid() {
      return identityOf(await kernel.json({ op: 'proc-identity' }), o).ppid;
    },
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
      handles.get(fd)?.();
      handles.delete(fd);
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
    sync,
    exit,
  };
  const drain = async (): Promise<void> => {
    for (;;) {
      await Promise.all([...pending]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (pending.size === 0) return;
    }
  };
  return { ctx, drain };
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

function pathOps(
  kernel: JsKernel,
  resolve: (path: string) => string,
  statOf: (op: 'stat' | 'lstat', path: string) => Promise<SyncFsBridgeStat>,
  open: (path: string, options?: JsOpenOptions) => Promise<JsFile>
): JsProgramContext['fs'] {
  return {
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
}
