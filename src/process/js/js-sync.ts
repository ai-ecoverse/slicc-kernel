import type { JsLane } from '../../kernel/protocol.ts';
import { SIG } from '../../kernel/signals.ts';
import {
  parseSyncFsStat,
  type SyncFsBridgeStat,
  type SyncFsResult,
} from '../../realm/sync-fs-wire.ts';
import { createSyncSabTransport } from '../../realm/sync-sab-bridge.ts';
import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';
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
  joined,
  MAX_IO,
  openRequest,
  readDevice,
  writeDevice,
  written,
} from './js-io.ts';
import { JsCallError, type JsKernel } from './js-kernel.ts';

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

export interface JsSyncContext {
  read(fd: number, max?: number): Uint8Array;
  write(fd: number, data: Uint8Array | string): void;
  close(fd: number): void;
  open(path: string, options?: JsOpenOptions): JsSyncFile;
  fs: {
    stat(path: string): SyncFsBridgeStat;
    lstat(path: string): SyncFsBridgeStat;
    exists(path: string): boolean;
    readdir(path: string): string[];
    mkdir(path: string): void;
    rm(path: string): void;
    unlink(path: string): void;
    rename(from: string, to: string): void;
    symlink(target: string, path: string): void;
    readlink(path: string): string;
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array | string): void;
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

export function laneOf(lane: JsLane | undefined): SyncCall {
  if (!lane) return () => ({ ok: false, errno: 'ENOSYS', message: 'no sync lane' });
  const transport = createSyncSabTransport(lane.sab, lane.port);
  return (req) => transport.call(req, Number.POSITIVE_INFINITY, req.op);
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
    if (!result.ok) throw new JsCallError(result.errno, req.op);
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
      if (result.errno !== 'EINTR') throw new JsCallError(result.errno, req.op);
    }
  }
}

export function syncOps(kernel: JsSyncKernel, shared: SyncShared): JsSyncContext {
  const { infos, handles, resolve } = shared;

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
    kernel.call({ op: 'fd-path-flush', path: abs });
    const s = parseSyncFsStat(kernel.json({ op, path: abs }));
    if (!s) throw new JsCallError('EIO', op);
    return s;
  };

  const open = (path: string, options: JsOpenOptions = {}): JsSyncFile => {
    const abs = resolve(path);
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
    open,
    fs: syncPathOps(kernel, resolve, statOf, open),
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
  open: (path: string, options?: JsOpenOptions) => JsSyncFile
): JsSyncContext['fs'] {
  return {
    stat: (path) => statOf('stat', path),
    lstat: (path) => statOf('lstat', path),
    exists: (path) => kernel.json({ op: 'exists', path: resolve(path) }) === true,
    readdir: (path) => kernel.json({ op: 'readdir', path: resolve(path) }) as string[],
    mkdir: (path) => void kernel.call({ op: 'mkdir', path: resolve(path) }),
    rm: (path) => void kernel.call({ op: 'rm', path: resolve(path) }),
    unlink: (path) => void kernel.call({ op: 'unlink', path: resolve(path) }),
    rename: (from, to) =>
      void kernel.call({ op: 'rename', path: resolve(from), arg2: resolve(to) }),
    symlink: (target, path) =>
      void kernel.call({ op: 'symlink', path: resolve(path), arg2: target }),
    readlink: (path) => String(kernel.json({ op: 'readlink', path: resolve(path) })),
    readFile(path) {
      const abs = resolve(path);
      kernel.call({ op: 'fd-path-flush', path: abs });
      return kernel.bytes({ op: 'read', path: abs });
    },
    writeFile(path, data) {
      const file = open(path, { write: true, create: true, truncate: true });
      try {
        file.write(0, typeof data === 'string' ? encoder.encode(data) : data);
      } finally {
        file.close();
      }
    },
  };
}
