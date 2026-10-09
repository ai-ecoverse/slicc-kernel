import {
  parseSyncFsStat,
  parseSyncFsUsage,
  SYNC_FS_REQUEST_TIMEOUT_MS,
  type SyncFsBridgeStat,
  type SyncFsPosixBridge,
  type SyncFsResult,
  syncError,
} from './sync-fs-wire.ts';
import {
  decodeSabResult,
  loadU53,
  publishMemory,
  SAB_I_CHUNK,
  SAB_I_OFFSET,
  SAB_I_OFFSET_HI,
  SAB_I_PUB,
  SAB_I_REQ,
  SAB_I_SEQ,
  SAB_I_STATE,
  SAB_I_STATUS,
  SAB_I_TOTAL,
  SAB_I_TOTAL_HI,
  SAB_STATE_IDLE,
  SAB_STATE_PENDING,
  SAB_STATE_READY,
  type SabViews,
  SYNC_SAB_NEXT_MSG,
  SYNC_SAB_REQ_MSG,
  type SyncSabNextMsg,
  type SyncSabReqMsg,
  type SyncSabRequestBody,
  sabViews,
} from './sync-sab-wire.ts';

export interface SabPostLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface SyncSabTransport {
  call(
    req: SyncSabRequestBody,
    timeoutMs: number,
    label: string,
    transfer?: Transferable[]
  ): SyncFsResult;
}

export type AtomicsWaitLike = (
  typedArray: Int32Array,
  index: number,
  value: number,
  timeout?: number
) => 'ok' | 'not-equal' | 'timed-out';

export function createSyncSabTransport(
  sab: SharedArrayBuffer,
  port: SabPostLike,
  deps: { wait?: AtomicsWaitLike; now?: () => number; memory?: () => number } = {}
): SyncSabTransport {
  const views: SabViews = sabViews(sab);
  const { header, window } = views;
  const wait: AtomicsWaitLike = deps.wait ?? ((a, i, v, t) => Atomics.wait(a, i, v, t));
  const now = deps.now ?? (() => performance.now());
  let seq = 0;

  function awaitReady(id: number, deadline: number, label: string): void {
    for (;;) {
      const published = Atomics.load(header, SAB_I_PUB);
      if (
        Atomics.load(header, SAB_I_STATE) === SAB_STATE_READY &&
        Atomics.load(header, SAB_I_SEQ) === id
      ) {
        return;
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw syncError('ETIMEDOUT', label);
      wait(header, SAB_I_PUB, published, remaining);
    }
  }

  return {
    call(req, timeoutMs, label, transfer = []): SyncFsResult {
      if (deps.memory) publishMemory(sab, deps.memory());
      const id = ++seq;
      const deadline = now() + timeoutMs;
      let out: Uint8Array | null = null;
      let status = 0;
      let offset = 0;
      Atomics.store(header, SAB_I_REQ, id);
      try {
        for (;;) {
          Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
          const msg: SyncSabReqMsg | SyncSabNextMsg =
            offset === 0
              ? { type: SYNC_SAB_REQ_MSG, id, req }
              : { type: SYNC_SAB_NEXT_MSG, id, offset };
          try {
            if (offset === 0 && transfer.length > 0) port.postMessage(msg, transfer);
            else port.postMessage(msg);
          } catch {
            throw syncError('EIO', label);
          }
          awaitReady(id, deadline, label);
          const total = loadU53(header, SAB_I_TOTAL, SAB_I_TOTAL_HI);
          const chunk = Atomics.load(header, SAB_I_CHUNK);
          const at = loadU53(header, SAB_I_OFFSET, SAB_I_OFFSET_HI);
          if (at !== offset || chunk < 0 || total < 0 || offset + chunk > total) {
            throw syncError('EIO', label);
          }
          if (out === null) {
            status = Atomics.load(header, SAB_I_STATUS);
            out = new Uint8Array(total);
          }
          out.set(window.subarray(0, chunk), offset);
          offset += chunk;
          if (offset >= total) break;

          if (chunk === 0) throw syncError('EIO', label);
        }
      } finally {
        Atomics.store(header, SAB_I_REQ, 0);
        Atomics.store(header, SAB_I_STATE, SAB_STATE_IDLE);
      }
      return decodeSabResult(status, out);
    },
  };
}

function errnoError(code: string, path: string): Error & { code: string } {
  return syncError(code, `sync-sab bridge, '${path}'`);
}

export function createSyncFsSabBridge(
  transport: SyncSabTransport,
  opts: { timeoutMs?: number } = {}
): SyncFsPosixBridge {
  const timeoutMs = opts.timeoutMs ?? SYNC_FS_REQUEST_TIMEOUT_MS;

  function run(req: SyncSabRequestBody, path: string, transfer?: Transferable[]): SyncFsResult {
    const result = transport.call(req, timeoutMs, `sync-sab bridge, '${path}'`, transfer);
    if (!result.ok) throw errnoError(result.errno, path);
    return result;
  }
  function bytes(req: SyncSabRequestBody, path: string): Uint8Array {
    const r = run(req, path);
    if (r.ok && r.kind === 'bytes') return r.bytes;
    throw errnoError('EIO', path);
  }
  function json(req: SyncSabRequestBody, path: string): unknown {
    const r = run(req, path);
    if (r.ok && r.kind === 'json') return r.json;
    throw errnoError('EIO', path);
  }

  return {
    readFile: (path) => bytes({ op: 'read', path }, path),
    writeFile: (path, data) => {
      run({ op: 'write', path, body: data }, path);
    },
    stat: (path) => {
      const s = parseSyncFsStat(json({ op: 'stat', path }, path));
      if (!s) throw errnoError('EIO', path);
      return s;
    },
    lstat: (path) => {
      const s = parseSyncFsStat(json({ op: 'lstat', path }, path));
      if (!s) throw errnoError('EIO', path);
      return s;
    },
    readdir: (path) => {
      const list = json({ op: 'readdir', path }, path);
      if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) {
        throw errnoError('EIO', path);
      }
      return list as string[];
    },
    readdirStat: (path) => {
      const list = json({ op: 'readdir-stat', path }, path);
      if (!Array.isArray(list)) throw errnoError('EIO', path);
      return list.map((entry): [string, SyncFsBridgeStat | null] => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw errnoError('EIO', path);

        if (entry[1] === null) return [entry[0], null];
        const stat = parseSyncFsStat(entry[1]);
        if (!stat) throw errnoError('EIO', path);
        return [entry[0], stat];
      });
    },
    exists: (path) => {
      const v = json({ op: 'exists', path }, path);
      if (typeof v !== 'boolean') throw errnoError('EIO', path);
      return v;
    },
    mkdir: (path) => {
      run({ op: 'mkdir', path }, path);
    },
    rm: (path) => {
      run({ op: 'rm', path }, path);
    },
    rename: (from, to) => {
      run({ op: 'rename', path: from, arg2: to }, from);
    },
    unlink: (path) => {
      run({ op: 'unlink', path }, path);
    },
    rmdir: (path) => {
      run({ op: 'rmdir', path }, path);
    },
    symlink: (target, linkPath) => {
      run({ op: 'symlink', path: linkPath, arg2: target }, linkPath);
    },
    readlink: (path) => {
      const target = json({ op: 'readlink', path }, path);
      if (typeof target !== 'string') throw errnoError('EIO', path);
      return target;
    },
    chmod: (path, mode) => {
      run({ op: 'chmod', path, mode }, path);
    },
    utimes: (path, atimeMs, mtimeMs) => {
      run({ op: 'utimes', path, atimeMs, mtimeMs }, path);
    },
    lutimes: (path, atimeMs, mtimeMs) => {
      run({ op: 'lutimes', path, atimeMs, mtimeMs }, path);
    },
    hold: (path, held) => {
      run({ op: 'hold', path, mode: held ? 1 : 0 }, path);
    },
    statfs: (path = '/') => parseSyncFsUsage(json({ op: 'statfs', path }, path)),
    pread: (path, offset, length, version) =>
      bytes({ op: 'pread', path, offset, length, ...(version ? { version } : {}) }, path),
    pwrite: (path, offset, body, transfer) => {
      const whole = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength;
      const owned = transfer && whole && body.buffer instanceof ArrayBuffer;
      run({ op: 'pwrite', path, offset, body }, path, owned ? [body.buffer as ArrayBuffer] : []);
    },
    truncate: (path, length) => {
      run({ op: 'truncate', path, length }, path);
    },
  };
}
