import { physicalPath } from '../../fs/physical-path.ts';
import type { JsLane } from '../../kernel/protocol.ts';
import { SIG } from '../../kernel/signals.ts';
import {
  parseSyncFsStat,
  SYNC_FS_READ_ONLY,
  SYNC_FS_REQUEST_TIMEOUT_MS,
  type SyncFsBridgeStat,
  type SyncFsResult,
} from '../../realm/sync-fs-wire.ts';
import { createSyncSabTransport, type SyncSabTransport } from '../../realm/sync-sab-bridge.ts';
import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';
import type { JsChild, JsSpawnOptions } from './js-children.ts';
import {
  devExists,
  devOpen,
  devReaddir,
  devReadlink,
  devResolveTarget,
  devStat,
  devSync,
  inDev,
  readWholeSync,
  streamSyncFile,
} from './js-dev.ts';
import {
  absent,
  brokenPipe,
  CHUNK,
  checkOpen,
  type FdInfo,
  fileWrite,
  index,
  isExclusive,
  type JsOpenOptions,
  type JsStatFs,
  joined,
  MAX_IO,
  openRequest,
  readDevice,
  statFsOf,
  writeDevice,
  written,
} from './js-io.ts';
import { callError, JsCallError, type JsKernel, modeOf } from './js-kernel.ts';
import { procFsSync, procOpenSync } from './js-proc.ts';
import type { JsRunOptions, JsRunResult } from './js-run.ts';

export type SyncCall = (req: SyncSabRequestBody) => SyncFsResult;

export interface JsSyncFile {
  readonly fd: number;
  readonly path: string;
  size(): number;
  read(position: number, length: number): Uint8Array;
  write(position: number, data: Uint8Array): number;
  truncate(size: number): void;
  sync(): void;
  close(): void;
}

export interface JsCred {
  ruid: number;
  euid: number;
  suid: number;
  rgid: number;
  egid: number;
  sgid: number;
  groups: number[];
}

export interface JsSyncContext {
  readonly kernel: { readonly version: string };
  run(options: JsRunOptions): JsRunResult;
  spawn(options: JsSpawnOptions): JsChild;
  exit(status?: number): never;
  kill(pid: number, signal?: number | `SIG${string}`): void;
  cred(): JsCred;
  umask(mask?: number): number;
  setcred(change: Partial<JsCred>): JsCred;
  read(fd: number, max?: number): Uint8Array;
  write(fd: number, data: Uint8Array | string): void;
  close(fd: number): void;
  open(path: string, options?: JsOpenOptions): JsSyncFile;
  fs: {
    stat(path: string): SyncFsBridgeStat;
    lstat(path: string): SyncFsBridgeStat;
    exists(path: string): boolean;
    readdir(path: string): string[];
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
    rm(path: string): void;
    unlink(path: string): void;
    rename(from: string, to: string): void;
    chmod(path: string, mode: number): void;
    link(from: string, to: string): void;
    symlink(target: string, path: string): void;
    readlink(path: string): string;
    statfs(path: string): JsStatFs;
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): void;
  };
}

export interface SyncShared {
  pid: number;
  resolve(path: string): string;
  random(bytes: Uint8Array): void;
  infos: Map<number, FdInfo>;
  handles: Map<number, () => void>;
}

const encoder = new TextEncoder();

export const noLane: SyncCall = () => ({ ok: false, errno: 'ENOSYS', message: 'no sync lane' });

export function laneOf(
  lane: JsLane | undefined,
  silence = SYNC_FS_REQUEST_TIMEOUT_MS,
  open: (sab: SharedArrayBuffer, port: JsLane['port']) => SyncSabTransport = createSyncSabTransport
): SyncCall {
  if (!lane) return noLane;
  const transport = open(lane.sab, lane.port);
  return (req) => {
    if (!SYNC_FS_READ_ONLY.has(req.op))
      return transport.call(req, Number.POSITIVE_INFINITY, req.op);
    try {
      return transport.call(req, silence, req.op);
    } catch (err) {
      const errno = (err as { code?: unknown } | null)?.code;
      return {
        ok: false,
        errno: typeof errno === 'string' ? errno : 'EIO',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

export class JsSyncKernel {
  private readonly lane: SyncCall;
  private readonly kernel: Pick<JsKernel, 'deliver'>;
  private readonly unwind: () => void;

  constructor(lane: SyncCall, kernel: Pick<JsKernel, 'deliver'>, unwind: () => void = () => {}) {
    this.lane = lane;
    this.kernel = kernel;
    this.unwind = unwind;
  }

  raw(req: SyncSabRequestBody): SyncFsResult {
    this.unwind();
    const result = this.lane(req);
    this.kernel.deliver();
    this.unwind();
    return result;
  }

  call(req: SyncSabRequestBody): SyncFsResult {
    const result = this.raw(req);
    if (!result.ok) throw callError(result, req.op);
    return result;
  }

  json(req: SyncSabRequestBody): unknown {
    const result = this.call(req);
    return result.ok && result.kind === 'json' ? result.json : undefined;
  }

  bytes(req: SyncSabRequestBody): Uint8Array {
    const result = this.call(req);
    return result.ok && result.kind === 'bytes' ? result.bytes : new Uint8Array(0);
  }

  blocking(req: SyncSabRequestBody): SyncFsResult {
    for (;;) {
      const result = this.raw(req);
      if (result.ok) return result;
      if (result.errno !== 'EINTR') throw callError(result, req.op);
    }
  }
}

export function syncOps(
  kernel: JsSyncKernel,
  shared: SyncShared
): Omit<
  JsSyncContext,
  'run' | 'spawn' | 'exit' | 'kill' | 'cred' | 'setcred' | 'kernel' | 'umask'
> {
  const { infos, handles, resolve } = shared;

  const tryDevSync = (abs: string): string | undefined => {
    try {
      const resolved = physicalPath(
        {
          lstat(p) {
            return parseSyncFsStat(kernel.json({ op: 'lstat', path: p })) ?? {};
          },
          readlink(p) {
            return String(kernel.json({ op: 'readlink', path: p }));
          },
        },
        abs
      );
      return resolved !== abs && inDev(resolved) ? resolved : undefined;
    } catch {
      return undefined;
    }
  };

  const info = (fd: number): FdInfo => {
    const known = infos.get(fd);
    if (known) return known;
    const got = kernel.json({ op: 'fd-info', fd }) as FdInfo;
    infos.set(fd, got);
    return got;
  };

  const read = (fd: number, max = CHUNK): Uint8Array => {
    index(max, 'read');
    const emulated = readDevice(info(fd), max, shared.random);
    if (emulated) return emulated;
    const r = kernel.blocking({ op: 'fd-read', fd, max: Math.min(max, MAX_IO) });
    return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
  };

  const write = (fd: number, data: Uint8Array | string): void => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const i = info(fd);
    if (writeDevice(i)) return;
    let at = 0;
    while (at < bytes.length) {
      const body = bytes.subarray(at, at + MAX_IO);
      try {
        at += written(kernel.blocking({ op: 'fd-write', fd, body }), body.length);
      } catch (err) {
        if (brokenPipe(err, i)) kernel.call({ op: 'proc-kill', pid: shared.pid, sig: SIG.PIPE });
        throw err;
      }
    }
  };

  const statOf = (op: 'stat' | 'lstat', path: string): SyncFsBridgeStat => {
    const abs = resolve(path);
    if (inDev(abs)) return devSync(kernel, devStat(abs, op === 'stat'));
    try {
      kernel.call({ op: 'fd-path-flush', path: abs });
      const s = parseSyncFsStat(kernel.json({ op, path: abs }));
      if (!s) throw new JsCallError('EIO', op);
      return s;
    } catch (err) {
      if (!(err instanceof JsCallError) || err.code !== 'ENOENT') throw err;
      const devPath = tryDevSync(abs);
      if (!devPath) throw err;
      return devSync(kernel, devStat(devPath, op === 'stat'));
    }
  };

  const openDev = (abs: string, options: JsOpenOptions): JsSyncFile => {
    const { fd, file, ...access } = devSync(kernel, devOpen(abs, options));
    const forget = () => {
      infos.delete(fd);
      handles.delete(fd);
    };
    if (file) infos.set(fd, { kind: 'file' });
    const close = (n: number) => {
      forget();
      kernel.call({ op: 'fd-close', fd: n });
    };
    const handle = file
      ? syncFile(kernel, fd, abs, options.append === true, forget)
      : streamSyncFile(fd, abs, { read: (n, max) => read(n, max), write, close }, access);
    handles.set(fd, handle.invalidate);
    return handle.file;
  };

  const open = (path: string, options: JsOpenOptions = {}): JsSyncFile => {
    const abs = resolve(path);
    if (inDev(abs)) return openDev(abs, options);
    try {
      let existing: SyncFsBridgeStat | undefined;
      try {
        existing = statOf(isExclusive(options) ? 'lstat' : 'stat', abs);
      } catch (err) {
        existing = absent(err);
      }
      checkOpen(abs, options, existing);
      const fd = kernel.json(openRequest(abs, options)) as number;
      try {
        kernel.call({ op: 'fd-vfs-stat', fd });
      } catch (err) {
        kernel.raw({ op: 'fd-close', fd });
        throw err;
      }
      infos.set(fd, { kind: 'file' });
      const handle = syncFile(kernel, fd, abs, options.append === true, () => {
        infos.delete(fd);
        handles.delete(fd);
      });
      handles.set(fd, handle.invalidate);
      return handle.file;
    } catch (err) {
      if (!(err instanceof JsCallError) || err.code !== 'ENOENT') throw err;
      const devPath = tryDevSync(abs);
      if (!devPath) throw err;
      return openDev(devPath, options);
    }
  };

  return {
    read,
    write,
    close(fd) {
      handles.get(fd)?.();
      handles.delete(fd);
      infos.delete(fd);
      kernel.call({ op: 'fd-close', fd });
    },
    open: procOpenSync(open, kernel, { resolve, pid: shared.pid }),
    fs: procFsSync(syncPathOps(kernel, resolve, statOf, open, tryDevSync), kernel, {
      resolve,
      pid: shared.pid,
    }),
  };
}

function syncFile(
  kernel: JsSyncKernel,
  fd: number,
  path: string,
  append: boolean,
  forget: () => void
): { file: JsSyncFile; invalidate: () => void } {
  let open = true;
  const live = (): void => {
    if (!open) throw new JsCallError('EBADF', path);
  };
  const file: JsSyncFile = {
    fd,
    path,
    size() {
      live();
      return (kernel.json({ op: 'fd-vfs-stat', fd }) as { size: number }).size;
    },
    read(position, length) {
      index(position, 'read');
      index(length, 'read');
      const parts: Uint8Array[] = [];
      let got = 0;
      do {
        live();
        const max = Math.min(length - got, MAX_IO);
        if (max <= 0) break;
        const chunk = kernel.bytes({ op: 'fd-pread', fd, offset: position + got, max });
        if (chunk.length === 0) break;
        parts.push(chunk);
        got += chunk.length;
      } while (got < length);
      return joined(parts, got);
    },
    write(position, data) {
      index(position, 'write');
      let at = 0;
      do {
        live();
        if (at >= data.length) break;
        const body = data.subarray(at, at + MAX_IO);
        const n = kernel.json(fileWrite(fd, append, position + at, body)) as number;
        if (!(n > 0)) throw new JsCallError('EIO', 'write');
        at += n;
      } while (at < data.length);
      return at;
    },
    truncate(size) {
      live();
      index(size, 'truncate');
      kernel.call({ op: 'fd-resize', fd, size });
    },
    sync() {
      live();
      kernel.call({ op: 'fd-flush', fd });
    },
    close() {
      live();
      open = false;
      forget();
      kernel.call({ op: 'fd-close', fd });
    },
  };
  return {
    file,
    invalidate: () => {
      open = false;
    },
  };
}

function syncPathOps(
  kernel: JsSyncKernel,
  resolve: (path: string) => string,
  statOf: (op: 'stat' | 'lstat', path: string) => SyncFsBridgeStat,
  open: (path: string, options?: JsOpenOptions) => JsSyncFile,
  tryDev: (abs: string) => string | undefined
): JsSyncContext['fs'] {
  return {
    stat: (path) => statOf('stat', path),
    lstat: (path) => statOf('lstat', path),
    exists(path) {
      const abs = resolve(path);
      if (inDev(abs)) return devSync(kernel, devExists(abs));
      if (kernel.json({ op: 'exists', path: abs }) === true) return true;
      const devPath = tryDev(abs);
      return devPath ? devSync(kernel, devExists(devPath)) : false;
    },
    readdir(path) {
      const abs = resolve(path);
      if (inDev(abs)) return devSync(kernel, devReaddir(abs));
      return kernel.json({ op: 'readdir', path: abs }) as string[];
    },
    mkdir: (path, options) =>
      void kernel.call({
        op: 'mkdir',
        path: resolve(path),
        ...(options?.recursive === false ? { exclusive: true } : {}),
        mode: options?.mode === undefined ? 0o777 : modeOf(options.mode),
      }),
    rm: (path) => void kernel.call({ op: 'rm', path: resolve(path) }),
    unlink: (path) => void kernel.call({ op: 'unlink', path: resolve(path) }),
    rename: (from, to) =>
      void kernel.call({ op: 'rename', path: resolve(from), arg2: resolve(to) }),
    chmod: (path, mode) =>
      void kernel.call({ op: 'chmod', path: resolve(path), mode: modeOf(mode) }),
    link: (from, to) => void kernel.call({ op: 'link', path: resolve(from), arg2: resolve(to) }),
    symlink: (target, path) =>
      void kernel.call({ op: 'symlink', path: resolve(path), arg2: target }),
    readlink(path) {
      const abs = resolve(path);
      if (inDev(abs)) return devSync(kernel, devReadlink(abs));
      return String(kernel.json({ op: 'readlink', path: abs }));
    },
    statfs(path) {
      let abs = resolve(path);
      if (inDev(abs)) {
        try {
          const target = devSync(kernel, devResolveTarget(abs)) as string | undefined;
          if (target?.startsWith('/')) abs = target;
        } catch {}
      }
      statOf('stat', abs);
      return statFsOf(kernel.json({ op: 'statfs', path: abs }));
    },
    readFile(path) {
      const abs = resolve(path);
      if (inDev(abs)) return readWholeSync(open(abs));
      try {
        kernel.call({ op: 'fd-path-flush', path: abs });
        return kernel.bytes({ op: 'read', path: abs });
      } catch (err) {
        if (!(err instanceof JsCallError) || err.code !== 'ENOENT') throw err;
        const devPath = tryDev(abs);
        if (!devPath) throw err;
        return readWholeSync(open(devPath));
      }
    },
    writeFile(path, data, options) {
      const mode = options?.mode;
      const file = open(path, {
        write: true,
        create: true,
        truncate: true,
        ...(mode !== undefined ? { mode } : {}),
      });
      try {
        file.write(0, typeof data === 'string' ? encoder.encode(data) : data);
      } finally {
        file.close();
      }
    },
  };
}
