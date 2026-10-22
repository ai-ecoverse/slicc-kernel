import { ChangeView } from '../fs/changes.ts';
import { rawWait } from '../kernel/cpu-clock.ts';
import {
  parseSyncFsStat,
  parseSyncFsUsage,
  SYNC_FS_OPS,
  SYNC_FS_READ_ONLY,
  SYNC_FS_REQUEST_TIMEOUT_MS,
  type SyncFsBridgeStat,
  type SyncFsFileIo,
  type SyncFsPosixBridge,
  type SyncFsRenames,
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

const UNCOUNTED_OPS: ReadonlySet<string> = new Set([...SYNC_FS_OPS, 'cwd-check', 'cwd-chdir']);

let calls = 0;

export function exactBody<T extends object>(
  req: T,
  transfer: Transferable[] = []
): { req: T; transfer: Transferable[] } {
  const body: unknown = (req as { body?: unknown }).body;
  if (!ArrayBuffer.isView(body)) return { req, transfer };
  if (Object.prototype.toString.call(body.buffer) === '[object SharedArrayBuffer]') {
    return { req, transfer };
  }
  const whole =
    (body as { constructor?: unknown }).constructor === Uint8Array &&
    body.byteOffset === 0 &&
    body.byteLength === body.buffer.byteLength;
  if (whole) return { req, transfer };
  const copy = new Uint8Array(body.byteLength);
  copy.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return { req: { ...req, body: copy }, transfer: [...transfer, copy.buffer] };
}

export function syncCallCount(): number {
  return calls;
}

let looks = 0;

export function lookedOutside(): void {
  looks++;
}

export function syncEpoch(): number {
  return calls + looks;
}

const SPIN_MS = 0.06;
const SPIN_STRIDE = 128;
const SPIN_STRIDES = 256;
const SPIN_CORES = 4;
const spinning = (globalThis.navigator?.hardwareConcurrency ?? 0) >= SPIN_CORES;
const SPIN_CAP_MS = 1;

export function createSyncSabTransport(
  sab: SharedArrayBuffer,
  port: SabPostLike,
  deps: { wait?: AtomicsWaitLike; now?: () => number; memory?: () => number } = {}
): SyncSabTransport {
  const views: SabViews = sabViews(sab);
  const { header, window } = views;
  const wait: AtomicsWaitLike = deps.wait ?? ((a, i, v, t) => rawWait(a, i, v, t));
  const now = deps.now ?? (() => performance.now());
  let seq = 0;
  let typical = 0;

  const ready = (id: number): boolean =>
    Atomics.load(header, SAB_I_STATE) === SAB_STATE_READY && Atomics.load(header, SAB_I_SEQ) === id;

  function spinUntil(id: number, until: number): boolean {
    for (let stride = 0; stride < SPIN_STRIDES; stride++) {
      for (let i = 0; i < SPIN_STRIDE; i++) if (ready(id)) return true;
      if (now() >= until) return false;
    }
    return false;
  }

  function settled(start: number): void {
    typical += (Math.min(now() - start, SPIN_CAP_MS) - typical) / 8;
  }

  function awaitReady(id: number, deadline: number, label: string): void {
    const start = now();
    if (spinning && typical < SPIN_MS && spinUntil(id, start + SPIN_MS)) {
      settled(start);
      return;
    }
    for (;;) {
      const published = Atomics.load(header, SAB_I_PUB);
      if (ready(id)) {
        settled(start);
        return;
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw syncError('EIO', label);
      wait(header, SAB_I_PUB, published, remaining);
    }
  }

  return {
    call(asked, timeoutMs, label, given = []): SyncFsResult {
      if (deps.memory) publishMemory(sab, deps.memory());
      const { req, transfer } = exactBody(asked, given);
      const id = ++seq;
      calls += Number(!UNCOUNTED_OPS.has(req.op));
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
          awaitReady(id, now() + timeoutMs, label);
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

function errnoError(code: string, path: string, direct?: true): Error & { code: string } {
  const err = syncError(code, `sync-sab bridge, '${path}'`);
  return direct ? Object.assign(err, { direct }) : err;
}

function holdSeen(seen: { gen?: number; nofollow?: boolean; ino?: number }) {
  return { gen: seen.gen, ino: seen.ino, ...(seen.nofollow ? { nofollow: true } : {}) };
}

export function createSyncFsSabBridge(
  transport: SyncSabTransport,
  opts: {
    timeoutMs?: number;
    owners?: boolean;
    links?: boolean;
    changes?: SharedArrayBuffer;
    direct?: boolean;
  } = {}
): SyncFsPosixBridge {
  const direct = opts.direct ? { direct: true } : {};
  const timeoutMs = opts.timeoutMs ?? SYNC_FS_REQUEST_TIMEOUT_MS;
  let identity: { identity: true } | Record<string, never> = {};
  let once = false;
  let last: SyncFsBridgeStat | null = null;

  function run(req: SyncSabRequestBody, path: string, transfer?: Transferable[]): SyncFsResult {
    last = null;
    const silence = SYNC_FS_READ_ONLY.has(req.op) ? timeoutMs : Number.POSITIVE_INFINITY;
    const result = transport.call(req, silence, `sync-sab bridge, '${path}'`, transfer);
    if (!result.ok) throw errnoError(result.errno, path, result.direct);
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

  const changing = (req: SyncSabRequestBody, path: string, transfer?: Transferable[]): void => {
    const ask = once ? { identity: true as const } : identity;
    once = false;
    const r = run({ ...req, ...ask }, path, transfer);
    if (r.ok && r.kind === 'json') last = parseSyncFsStat(r.json);
  };

  const io = (id: { handle?: number }): SyncFsFileIo => ({
    readFile: (path) => bytes({ op: 'read', path, ...id }, path),
    writeFile: (path, data, open) => {
      changing({ op: 'write', path, body: data, ...(open ? { mode: 1 } : {}), ...id }, path);
    },
    pread: (path, offset, length, version) =>
      bytes({ op: 'pread', path, offset, length, ...(version ? { version } : {}), ...id }, path),
    pwrite: (path, offset, body, transfer) => {
      const whole = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength;
      const owned = transfer && whole && body.buffer instanceof ArrayBuffer;
      const transferred = owned ? [body.buffer as ArrayBuffer] : [];
      changing({ op: 'pwrite', path, offset, body, ...id }, path, transferred);
    },
    truncate: (path, length) => {
      changing({ op: 'truncate', path, length, ...id }, path);
    },
    append: (path, body) => json({ op: 'append', path, body, ...id }, path) as number,
  });

  return {
    ...io({}),
    pinned: (handle) => io({ handle }),
    kept: (handle) => json({ op: 'kept', path: '/', handle }, '/') === true,
    keptStat: (handle) => {
      const s = parseSyncFsStat(json({ op: 'stat', path: '/', handle }, '/'));
      if (!s) throw errnoError('EIO', '/');
      return s;
    },
    stat: (path) => {
      const s = parseSyncFsStat(json({ op: 'stat', path, ...direct }, path));
      if (!s) throw errnoError('EIO', path);
      return s;
    },
    lstat: (path) => {
      const s = parseSyncFsStat(json({ op: 'lstat', path, ...direct }, path));
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
    mkdir: (path, mode) => {
      run({ op: 'mkdir', path, exclusive: true, ...(mode !== undefined ? { mode } : {}) }, path);
    },
    rm: (path) => {
      run({ op: 'rm', path }, path);
    },
    rename: (from, to) => {
      const r = run({ op: 'rename', path: from, arg2: to }, from);
      const seq = r.ok && r.kind === 'json' ? (r.json as { seq?: unknown }).seq : undefined;
      return typeof seq === 'number' ? seq : undefined;
    },
    link: (from, to, follow) => {
      run({ op: 'link', path: from, arg2: to, ...(follow ? { mode: 1 } : {}) }, from);
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
      changing({ op: 'chmod', path, mode }, path);
    },
    utimes: (path, atimeMs, mtimeMs, now) => {
      changing({ op: 'utimes', path, atimeMs, mtimeMs, ...(now ? { now } : {}) }, path);
    },
    identify: () => {
      identity = { identity: true };
    },
    identifyNext: () => {
      once = true;
      last = null;
    },
    identified: () => {
      once = false;
      return last;
    },
    lutimes: (path, atimeMs, mtimeMs, now) => {
      run({ op: 'lutimes', path, atimeMs, mtimeMs, ...(now ? { now } : {}) }, path);
    },
    mkfifo: (path, mode) => {
      run({ op: 'mkfifo', path, mode }, path);
    },
    copy: (from, to, mode, exclusive) => {
      run({ op: 'copy', path: from, arg2: to, mode, ...(exclusive ? { exclusive } : {}) }, to);
    },
    create: (path, mode, opening) => {
      const flags = { ...(mode !== undefined ? { mode } : {}), ...(opening ? { opening } : {}) };
      const r = run({ op: 'create', path, ...flags, identity: true }, path);
      if (!r.ok || r.kind !== 'json') return undefined;
      const st = parseSyncFsStat(r.json);
      if (!st) return undefined;
      const { seen } = r.json as { seen?: unknown };
      return typeof seen === 'number' ? { ...st, seen } : st;
    },
    chown: (path, uid, gid, follow, handle) => {
      const ids = { ...(uid !== undefined ? { uid } : {}), ...(gid !== undefined ? { gid } : {}) };
      changing(
        {
          op: follow ? 'chown' : 'lchown',
          path,
          ...ids,
          ...(handle !== undefined ? { handle } : {}),
        },
        path
      );
    },
    ...(opts.owners ? { owners: true } : {}),
    ...(opts.links ? { links: true } : {}),
    ...(opts.changes ? { changes: new ChangeView(opts.changes) } : {}),
    access: (path, mode, kind = 'access', nofollow) => {
      run({ op: 'access', path, mode, arg2: kind, ...(nofollow ? { nofollow } : {}) }, path);
    },
    hold: (path, held, open, handle, want = 0, seen = {}) => {
      const mode = (held ? 1 : 0) | (open ? 2 : 0);
      if (mode === 3) {
        return json({ op: 'hold', path, mode: mode | want, ...holdSeen(seen) }, path) as number;
      }
      run({ op: 'hold', path, mode, ...(handle !== undefined ? { handle } : {}) }, path);
      return undefined;
    },
    statfs: (path = '/') => parseSyncFsUsage(json({ op: 'statfs', path }, path)),
    renames: (since, held) =>
      json(
        { op: 'renames', path: '/', offset: since, arg2: JSON.stringify(held) },
        '/'
      ) as SyncFsRenames,
  };
}
