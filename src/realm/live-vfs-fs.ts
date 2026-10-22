import { permits, X_OK } from '../fs/access.ts';
import { type ChangeView, RENAME_WAIT_MS, SHARED_TTL_MS } from '../fs/changes.ts';
import {
  linkedWatch,
  RangedFile,
  type RangedIo,
  type RangedWatch,
  watchedChange,
} from '../fs/ranged.ts';
import { inodeOf } from '../fs/types.ts';
import type { Cred } from '../kernel/cred.ts';
import { wasiErrno } from '../process/wasi-errno.ts';
import {
  HOLD_CREATED,
  HOLD_READ,
  HOLD_WRITE,
  type SyncFsBridgeStat,
  type SyncFsFileIo,
  type SyncFsPosixBridge,
  type SyncFsUsage,
} from './sync-fs-wire.ts';
import { syncCallCount, syncEpoch } from './sync-sab-bridge.ts';

export type LiveCred = Cred;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;
const S_IFIFO = 0o010000;
const S_IFMT = 0o170000;
const PERM_MASK = 0o7777;

const DEFAULT_DIR_PERM = 0o755;

const UMASK = 0o022;
const SEEK_CUR = 1;
const SEEK_END = 2;

interface LiveNodeState {
  named?: number | undefined;
  watch?: RangedWatch | undefined;
  stat?: SyncFsBridgeStat;
  bound?: SyncFsBridgeStat;
  statAt?: number;
  filledAt?: number;
  statGen?: number;
  seenAt?: number;

  data?: Uint8Array;
  len: number;
  loaded: boolean;
  dirty: boolean;
  openCount: number;
  writers?: number;

  orphan?: boolean;

  kept?: boolean;

  id?: string;

  listed?: Map<string, SyncFsBridgeStat>;
  listedAt?: number;
  listedGen?: number | undefined;

  maxFile?: number;

  ranges?: boolean;
  ranged?: RangedFile;
  seen?: number | undefined;
  handle?: number;
  created?: boolean;
}

export interface LiveFsNode {
  id: number;
  name: string;
  mode: number;
  parent: LiveFsNode;
  mount: LiveFsMount;
  node_ops: LiveNodeOps;
  stream_ops: LiveStreamOps;
  live: LiveNodeState;
  mounted?: unknown;
}

export interface LiveFsStream {
  node: LiveFsNode;
  position: number;
  flags: number;
  fd?: number;
}

export interface LiveFsMount {
  opts: LiveFsMountOpts;
  mountpoint: string;
  root: LiveFsNode;
}

export interface LiveFsMountOpts {
  root: string;
  bridge: SyncFsPosixBridge;
}

interface LiveAttr {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  blksize: number;
  blocks: number;
}

interface LiveSetAttr {
  mode?: number;
  size?: number;
  atime?: number | Date | null;
  mtime?: number | Date | null;
  timestamp?: number;
}

export interface LiveNodeOps {
  getattr(node: LiveFsNode): LiveAttr;
  setattr(node: LiveFsNode, attr: LiveSetAttr): void;
  lookup(parent: LiveFsNode, name: string): LiveFsNode;
  mknod(parent: LiveFsNode, name: string, mode: number, dev: number): LiveFsNode;
  rename(oldNode: LiveFsNode, newDir: LiveFsNode, newName: string): void;
  unlink(parent: LiveFsNode, name: string): void;
  rmdir(parent: LiveFsNode, name: string): void;
  readdir(node: LiveFsNode): string[];
  symlink(parent: LiveFsNode, newName: string, target: string): LiveFsNode;
  readlink(node: LiveFsNode): string;
}

export interface LiveStreamOps {
  open(stream: LiveFsStream): void;

  dup(stream: LiveFsStream): void;
  close(stream: LiveFsStream): void;
  read(
    stream: LiveFsStream,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position: number
  ): number;
  write(
    stream: LiveFsStream,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position: number
  ): number;
  llseek(stream: LiveFsStream, offset: number, whence: number): number;
  fsync(stream: LiveFsStream): void;
}

export interface LiveFsApi {
  createNode(parent: LiveFsNode | null, name: string, mode: number, dev?: number): LiveFsNode;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  isLink(mode: number): boolean;
  ErrnoError: new (errno: number) => Error & { errno: number };
  closeStream?(fd: number): void;
  sliccTouch?: boolean;
  sliccReading?: LiveFsNode | undefined;
  sliccCred?: LiveCred;
  sliccOpenFifo?(stream: LiveFsStream, path: string): void;

  nameTable?: (LiveFsNode | null)[] | null;
  hashRemoveNode?(node: LiveFsNode): void;
  hashAddNode?(node: LiveFsNode): void;
  hashName?(parentId: number, name: string): number;
  lookupNode?(parent: LiveFsNode, name: string): LiveFsNode;
  lookupPath?(path: string, opts?: { follow?: boolean; parent?: boolean }): { node: object };
  open?(...args: unknown[]): unknown;
}

export interface LiveVfsPlugin {
  mount(mount: LiveFsMount): LiveFsNode;
  node_ops: LiveNodeOps;
  stream_ops: LiveStreamOps;
  flushDirty(): void;

  mounts: Set<LiveFsMount>;
  handled?: Set<LiveFsNode>;
}

function toErrno(Fs: LiveFsApi, err: unknown): Error {
  if ((err as { errno?: unknown })?.errno !== undefined && err instanceof Fs.ErrnoError) {
    return err;
  }
  const code = (err as { code?: unknown })?.code;
  const errno = wasiErrno(typeof code === 'string' ? code : 'EIO');
  return new Fs.ErrnoError(errno);
}

export function liveNodePath(node: LiveFsNode): string {
  const parts: string[] = [];
  let cur = node;
  while (cur !== cur.mount.root) {
    parts.push(cur.name);
    cur = cur.parent;
  }
  const root = node.mount.opts.root.replace(/\/+$/, '');
  return parts.length === 0 ? root || '/' : `${root}/${parts.reverse().join('/')}`;
}

function exactIn(node: LiveFsNode | null): boolean {
  return node?.mount.opts.bridge.owners === true;
}

function modeFromStat(st: SyncFsBridgeStat, exact = false): number {
  const type = st.isSymbolicLink
    ? S_IFLNK
    : st.isDirectory
      ? S_IFDIR
      : st.isSocket
        ? S_IFSOCK
        : st.isFifo
          ? S_IFIFO
          : S_IFREG;
  const fallback = st.isDirectory || st.isSymbolicLink ? 0o777 : 0o666;
  const perm = (st.mode ?? fallback) & PERM_MASK;
  return type | (exact ? perm : perm || fallback);
}

function toMs(v: number | Date | null | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  return v instanceof Date ? v.getTime() : v;
}

interface LiveOpsTables {
  node?: LiveNodeOps;
  stream?: LiveStreamOps;
}

const EARLY_WHOLE_FILE = 64 * 1024;

function needsLoad(s: LiveNodeState, view: ChangeView | undefined, path: () => string): boolean {
  if (s.loaded && view && !s.dirty) {
    const watch = s.watch ?? { view, stat: () => ({ size: s.len }) };
    const { now, changed } = watchedChange(watch, s.seen ?? 0, path());
    s.seen = now;
    if (changed) {
      s.loaded = false;
      s.stat = undefined;
    }
  }
  if (s.loaded) return false;
  s.seen = view?.now();
  return true;
}

function loadedWatch(
  bridge: SyncFsPosixBridge,
  call: <T>(fn: () => T) => T,
  path: () => string,
  st: SyncFsBridgeStat | { size: number }
): RangedWatch | undefined {
  const view = bridge.changes;
  return view && linkedWatch({ view, stat: () => call(() => bridge.stat(path())) }, st);
}

function rangedFileOf(
  bridge: SyncFsPosixBridge,
  call: <T>(fn: () => T) => T,
  path: () => string,
  io: RangedIo
): RangedFile {
  const seen = bridge.changes?.now();
  const stat = () => call(() => bridge.stat(path()));
  const st = stat();
  const watch =
    bridge.changes && linkedWatch({ view: bridge.changes, ino: st.ino, seen, stat }, st);
  return new RangedFile(io, path(), st.size, st.version, watch);
}
const O_APPEND = 0o2000;

function unlessIo<T>(op: () => T): T | undefined {
  try {
    return op();
  } catch (err) {
    if ((err as { errno?: unknown }).errno === wasiErrno('EIO')) return undefined;
    throw err;
  }
}

const O_ACCMODE = 3;
const O_TRUNC = 0o1000;
const O_PATH = 0o10000000;

function wantOf(flags: number): number {
  if (flags & O_PATH) return 0;
  const mode = flags & O_ACCMODE;
  const read = mode === 1 ? 0 : HOLD_READ;
  const write = mode !== 0 || (flags & O_TRUNC) !== 0 ? HOLD_WRITE : 0;
  return read | write;
}

function accessOf(want: number): number {
  return (want & HOLD_READ ? 4 : 0) | (want & HOLD_WRITE ? 2 : 0);
}

function refusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function gone(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

function young(s: LiveNodeState): boolean {
  return performance.now() - (s.filledAt ?? Number.NEGATIVE_INFINITY) < SHARED_TTL_MS;
}

function cachedStat(node: LiveFsNode, dir: boolean, view?: ChangeView): boolean {
  const s = node.live;
  if (view?.foreign() && !s.dirty) {
    const gen = s.statGen ?? s.named;
    if (s.openCount > 0 || !young(s) || gen === undefined) return false;
    if (view.changedSince(gen, liveNodePath(node)).changed) return false;
  }
  return s.stat !== undefined && (!dir || s.statAt === syncCallCount());
}

function searchParents(
  Fs: LiveFsApi,
  node: LiveFsNode,
  bridge: SyncFsPosixBridge,
  call: <T>(fn: () => T) => T
): void {
  const cred = Fs.sliccCred;
  if (!cred) return;
  let cur = node.parent;
  while (cur) {
    const st = cur.live.stat;
    if (st && st.uid !== undefined && st.mode !== undefined) {
      const perm = { uid: st.uid, gid: st.gid ?? 0, mode: st.mode & 0o7777 };
      if (!permits(cred, perm, X_OK, true)) {
        call(() => bridge.access?.(liveNodePath(cur), X_OK, 'eaccess'));
        cur.live.stat = undefined;
        return;
      }
    } else {
      call(() => bridge.access?.(liveNodePath(cur), X_OK, 'eaccess'));
      return;
    }
    if (cur === cur.parent) break;
    cur = cur.parent;
  }
}

const stale = (s: LiveNodeState): boolean => !!s.orphan && !s.kept;

function linkedStates(bridgeOf: (node: LiveFsNode) => SyncFsPosixBridge) {
  const opens = new Map<LiveNodeState, LiveFsNode>();
  const byId = new Map<string, LiveNodeState>();
  const idOf = (st: SyncFsBridgeStat | undefined): string | undefined =>
    st?.ino === undefined || (st.nlink ?? 1) < 2 ? undefined : `${st.dev}:${st.ino}`;

  function know(s: LiveNodeState, id: string): void {
    s.id = id;
    if (!byId.has(id)) byId.set(id, s);
  }

  function opening(node: LiveFsNode, on: boolean): void {
    const s = node.live;
    if (!on) {
      opens.delete(s);
      if (s.id !== undefined && byId.get(s.id) === s) byId.delete(s.id);
      s.id = undefined;
      return;
    }
    opens.set(s, node);
    const id = idOf(s.stat);
    if (id !== undefined) know(s, id);
  }

  function sharedWith(node: LiveFsNode): LiveNodeState | undefined {
    const st = node.live.stat;
    if (st?.ino === undefined) return undefined;
    const id = `${st.dev}:${st.ino}`;
    if (!byId.has(id) && idOf(st) !== undefined) {
      for (const [s, other] of opens) {
        if (s.id !== undefined || s.orphan) continue;
        let st: SyncFsBridgeStat | undefined;
        try {
          st = bridgeOf(other).lstat(liveNodePath(other));
        } catch {}
        const known = idOf(st);
        if (known !== undefined) know(s, known);
      }
    }
    const s = byId.get(id);
    return s && s !== node.live && !stale(s) ? s : undefined;
  }
  const holder = (node: LiveFsNode): LiveFsNode => opens.get(node.live) ?? node;
  return { opening, sharedWith, know, idOf, holder };
}

function filled(
  s: LiveNodeState,
  stat: SyncFsBridgeStat,
  asked: { statGen: number | undefined; filledAt: number }
): void {
  Object.assign(s, { stat, statAt: syncCallCount(), seenAt: syncEpoch(), ...asked });
}

interface Asked {
  filledAt: number;
  statGen: number | undefined;
}

function asking(bridge: SyncFsPosixBridge): Asked {
  return { filledAt: performance.now(), statGen: bridge.changes?.now() };
}

function listing(s: LiveNodeState): Asked {
  return { filledAt: s.listedAt ?? Number.NEGATIVE_INFINITY, statGen: s.listedGen };
}

function answeredAt(node: LiveFsNode, asked: Asked): LiveFsNode {
  Object.assign(node.live, asked);
  return node;
}

function freshState(stat?: SyncFsBridgeStat): LiveNodeState {
  const base = { len: 0, loaded: false, dirty: false, openCount: 0 };
  return stat
    ? { stat, statAt: syncCallCount(), filledAt: performance.now(), seenAt: syncEpoch(), ...base }
    : base;
}

function inCache(Fs: LiveFsApi, node: LiveFsNode): boolean {
  const table = Fs.nameTable;
  const parent = node.parent as LiveFsNode & { id?: number };
  const hash = Fs.hashName?.(parent.id ?? 0, node.name);
  if (!table || hash === undefined) return true;
  let at: LiveFsNode | null | undefined = table[hash];
  while (at) {
    if (at === node) return true;
    at = (at as LiveFsNode & { name_next?: LiveFsNode | null }).name_next;
  }
  return false;
}

function heldUnder(held: LiveFsNode, from: string): LiveFsNode | undefined {
  let moving: LiveFsNode | undefined = held;
  while (moving && moving !== moving.mount.root && liveNodePath(moving) !== from) {
    moving = moving.parent;
  }
  return moving && moving !== moving.mount.root && liveNodePath(moving) === from
    ? moving
    : undefined;
}

function relinked(Fs: LiveFsApi, moving: LiveFsNode, to: string): void {
  const slash = to.lastIndexOf('/');
  let dir: LiveFsNode | undefined;
  try {
    dir = Fs.lookupPath?.(slash <= 0 ? '/' : to.slice(0, slash)).node as LiveFsNode;
  } catch {}
  if (!dir || dir.mount !== moving.mount) return;
  const name = to.slice(slash + 1);
  try {
    const existing = Fs.lookupNode?.(dir, name);
    if (existing && existing !== moving) Fs.hashRemoveNode?.(existing);
  } catch {}
  moving.parent.live.listed = undefined;
  dir.live.listed = undefined;
  Fs.hashRemoveNode?.(moving);
  moving.name = name;
  moving.parent = dir;
  Fs.hashAddNode?.(moving);
  moving.live.stat = undefined;
}

function renameFollower(
  Fs: LiveFsApi,
  bridgeOf: (node: LiveFsNode) => SyncFsPosixBridge,
  call: <T>(fn: () => T) => T
) {
  const open = new Set<LiveFsNode>();
  const seen = new Map<SyncFsPosixBridge, number>();
  const follow = (node: LiveFsNode, missing = false): boolean => {
    const bridge = bridgeOf(node);
    const view = bridge.changes;
    const since = seen.get(bridge);
    let now = view?.renames() ?? 0;
    if (missing && view && now === since) now = view.awaitRename(now, RENAME_WAIT_MS);
    const ask = bridge.renames?.bind(bridge);
    if (since === undefined || now === since || !ask) return false;
    const held = [...open].filter((n) => !n.live.orphan && bridgeOf(n) === bridge);
    if (held.length === 0) {
      seen.set(bridge, now);
      return false;
    }
    const reply = call(() =>
      ask(
        since,
        held.map((n) => liveNodePath(n))
      )
    );
    seen.set(bridge, reply.now);
    for (const [from, to] of reply.renames) {
      for (const n of held) {
        const moving = heldUnder(n, from);
        if (moving && inCache(Fs, moving)) relinked(Fs, moving, to);
      }
    }
    return reply.renames.length > 0;
  };
  return {
    open,
    follow,
    track(node: LiveFsNode, on: boolean): void {
      node.live.bound = on && node.live.stat?.ino !== undefined ? node.live.stat : undefined;
      if (!on) {
        open.delete(node);
        return;
      }
      follow(node);
      open.add(node);
    },
    watchRenames(bridge: SyncFsPosixBridge): void {
      if (!seen.has(bridge)) seen.set(bridge, bridge.changes?.renames() ?? 0);
    },
    ownRename(bridge: SyncFsPosixBridge, seq: number | undefined): void {
      const since = seen.get(bridge);
      if (seq !== undefined && since !== undefined && seq === ((since + 1) | 0))
        seen.set(bridge, seq);
    },
  };
}

function followingOnce(write: () => void, follow: () => boolean): void {
  try {
    write();
  } catch (err) {
    if ((err as { errno?: number }).errno !== wasiErrno('ENOENT') || !follow()) throw err;
    write();
  }
}

function openReplaced(
  h: LiveHelpers,
  dir: LiveFsNode,
  name: string,
  moving: LiveFsNode
): { node: LiveFsNode; st: SyncFsBridgeStat } | undefined {
  let node: LiveFsNode | undefined;
  try {
    node = h.Fs.lookupNode?.(dir, name);
  } catch {
    return undefined;
  }
  if (!node || node === moving || node.live?.openCount === 0 || !h.Fs.isFile(node.mode))
    return undefined;
  const st = freshStat(h, node);
  const ranged = h.rangedOf(node);
  if (ranged) ranged.prefetch();
  else h.ensureLoaded(node);
  return { node, st };
}

function renamedOver(
  h: LiveHelpers,
  dir: LiveFsNode,
  name: string,
  moving: LiveFsNode,
  rename: () => void
): void {
  const replaced = openReplaced(h, dir, name, moving);
  rename();
  if (replaced) {
    h.rangedOf(replaced.node)?.pin();
    orphaned(h, replaced.node, replaced.st);
  }
  try {
    const existing = h.Fs.lookupNode?.(dir, name);
    if (existing && existing !== moving) h.Fs.hashRemoveNode?.(existing);
  } catch {}
}

function renameThrough(h: LiveHelpers, node: LiveFsNode, from: string, to: string): void {
  const seq = h.call(() => h.bridgeOf(node).rename(from, to));
  h.ownRename(h.bridgeOf(node), typeof seq === 'number' ? seq : undefined);
}

function heldStream(h: LiveHelpers, stream: LiveFsStream, change: 1 | -1): void {
  const s = stream.node.live;
  if ((stream.flags & 3) === 0 || s.orphan) return;
  const before = s.writers ?? 0;
  s.writers = Math.max(0, before + change);
  if ((before === 0) !== (s.writers === 0)) {
    try {
      h.bridgeOf(stream.node).hold?.(liveNodePath(stream.node), s.writers > 0);
    } catch {}
  }
}

function adopted(
  node: LiveFsNode,
  st: SyncFsBridgeStat,
  asked: { statGen: number | undefined; filledAt: number }
): boolean {
  const bound = node.live.openCount > 0 ? node.live.bound : undefined;
  if (bound && st.ino !== bound.ino) return false;
  filled(node.live, st, asked);
  node.mode = modeFromStat(st, exactIn(node));
  return true;
}

function createHelpers(Fs: LiveFsApi, ops: LiveOpsTables) {
  const bridgeOf = (node: LiveFsNode): SyncFsPosixBridge => node.mount.opts.bridge;
  const fileIo = (node: LiveFsNode): SyncFsFileIo => pinnedIo(bridgeOf(node), node.live.handle);
  const dirty = new Set<LiveFsNode>();
  const handled = new Set<LiveFsNode>();
  const linked = linkedStates(bridgeOf);
  const renames = renameFollower(Fs, bridgeOf, (fn) => call(fn));
  function markDirty(node: LiveFsNode): void {
    node.live.dirty = true;
    dirty.add(node);
  }

  function flushDirty(): void {
    for (const node of [...dirty]) {
      const s = node.live;
      if (!s.dirty || stale(s)) {
        dirty.delete(node);
        continue;
      }
      if (!s.ranged && s.len > EARLY_WHOLE_FILE) continue;
      try {
        flushNode(node);
        dirty.delete(node);
      } catch {}
    }
  }

  function call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw toErrno(Fs, err);
    }
  }

  function metadataCall(fn: () => void): void {
    try {
      call(fn);
    } catch (err) {
      if ((err as { errno?: number }).errno !== wasiErrno('ENOSYS')) throw err;
    }
  }

  function makeNode(parent: LiveFsNode | null, name: string, st: SyncFsBridgeStat): LiveFsNode {
    const node = Fs.createNode(parent, name, modeFromStat(st, exactIn(parent)), 0);
    node.node_ops = ops.node as LiveNodeOps;
    node.stream_ops = ops.stream as LiveStreamOps;
    node.live = freshState(st);
    return node;
  }

  function statOf(node: LiveFsNode): SyncFsBridgeStat {
    if (node.live.orphan) {
      const size = node.live.ranged?.size() ?? node.live.len;
      return { ...(node.live.stat as SyncFsBridgeStat), size };
    }
    const view = bridgeOf(node).changes;
    if (!cachedStat(node, Fs.isDir(node.mode), view)) {
      const asked = { statGen: view?.now(), filledAt: performance.now() };
      const st = call(() => bridgeOf(node).lstat(liveNodePath(linked.holder(node))));
      if (!adopted(node, st, asked)) return node.live.bound as SyncFsBridgeStat;
    }
    return node.live.stat as SyncFsBridgeStat;
  }

  function childPath(parent: LiveFsNode, name: string): string {
    const base = liveNodePath(parent);
    return base === '/' ? `/${name}` : `${base}/${name}`;
  }

  function ensureLoaded(node: LiveFsNode): void {
    const s = node.live;
    if (!needsLoad(s, bridgeOf(node).changes, () => liveNodePath(linked.holder(node)))) return;
    const path = () => liveNodePath(linked.holder(node));
    const bytes = call(() => fileIo(node).readFile(path()));
    Object.assign(s, { data: bytes, len: bytes.length, loaded: true });
    s.watch = loadedWatch(bridgeOf(node), call, path, s.stat ?? { size: bytes.length });
  }

  function rangedOf(node: LiveFsNode): RangedFile | undefined {
    const s = node.live;
    if (s.ranged || !s.ranges) return s.ranged;
    const bridge = bridgeOf(node);
    const path = () => liveNodePath(linked.holder(node));
    const file = () => fileIo(node) as Required<SyncFsFileIo>;
    const io = {
      pread: (_: string, at: number, n: number, version?: string) =>
        file().pread(path(), at, n, version),
      pwrite: (_: string, at: number, bytes: Uint8Array, transfer?: boolean) =>
        file().pwrite(path(), at, bytes, transfer),
      truncate: (_: string, size: number) => file().truncate(path(), size),
    };
    s.ranged = rangedFileOf(bridge, call, path, io);
    return s.ranged;
  }

  function ensureCapacity(node: LiveFsNode, need: number): Uint8Array {
    const s = node.live;
    const cur = s.data ?? new Uint8Array(0);
    if (cur.length >= need) return cur;
    const grown = new Uint8Array(Math.max(need, cur.length * 2, 256));
    grown.set(cur.subarray(0, s.len));
    s.data = grown;
    return grown;
  }

  function flushNode(node: LiveFsNode): void {
    const s = node.live;
    if (!s.dirty || stale(s) || !(s.data || s.ranged)) return;
    const whole = () => (s.data as Uint8Array).slice(0, s.len);
    const write = () =>
      s.ranged
        ? call(() => s.ranged?.flush())
        : call(() => fileIo(node).writeFile(liveNodePath(linked.holder(node)), whole(), true));
    followingOnce(write, () => renames.follow(node, true));
    s.dirty = false;
    s.stat = undefined;
  }

  function truncate(node: LiveFsNode, size: number): void {
    const s = node.live;
    if (!s.orphan) {
      const st = statOf(node);
      if (st.readonly) throw new Fs.ErrnoError(wasiErrno('EROFS'));
      if (st.maxFile !== undefined && size > st.maxFile) {
        throw new Fs.ErrnoError(wasiErrno('EFBIG'));
      }
    }
    const ranged = s.openCount > 0 ? rangedOf(node) : undefined;
    if (ranged) {
      ranged.truncate(size);
      markDirty(node);
      return;
    }
    if (s.openCount > 0) {
      if (size > 0) ensureLoaded(node);
      else s.loaded = true;
      const buf = ensureCapacity(node, size);
      if (size > s.len) buf.fill(0, s.len, size);
      s.len = size;
      markDirty(node);
      return;
    }

    const path = liveNodePath(node);
    const bridge = bridgeOf(node);
    if (statOf(node).ranged && bridge.truncate) {
      call(() => bridge.truncate?.(path, size));
      s.stat = undefined;
      return;
    }
    const bytes = new Uint8Array(size);
    if (size > 0) {
      const cur = call(() => bridgeOf(node).readFile(path));
      bytes.set(cur.subarray(0, Math.min(size, cur.length)));
    }
    call(() => bridgeOf(node).writeFile(path, bytes));
    s.stat = undefined;
  }

  return {
    Fs,
    bridgeOf,
    handled,
    linked,
    ...renames,
    call,
    metadataCall,
    makeNode,
    statOf,
    childPath,
    ensureLoaded,
    ensureCapacity,
    rangedOf,
    flushNode,
    markDirty,
    flushDirty,
    truncate,
  };
}

type LiveHelpers = ReturnType<typeof createHelpers>;

function freshStat(h: LiveHelpers, node: LiveFsNode): SyncFsBridgeStat {
  const { statOf } = h;
  const st = statOf(node);
  if (!st.linkable) return st;
  node.live.stat = undefined;
  return statOf(node);
}

function orphaned(h: LiveHelpers, node: LiveFsNode, st: SyncFsBridgeStat): void {
  const { bridgeOf } = h;
  const s = node.live;
  const nlink = st.nlink ?? 1;
  let kept = false;
  try {
    kept = nlink > 1 && s.handle !== undefined && bridgeOf(node).kept?.(s.handle) === true;
  } catch {}
  if (nlink > 1 && !kept && h.linked.holder(node) !== node) {
    s.stat = undefined;
    return;
  }
  s.orphan = true;
  if (!kept) return;
  s.kept = true;
  s.stat = { ...st, nlink: nlink - 1 };
  const id = h.linked.idOf(st);
  if (id !== undefined) h.linked.know(s, id);
}

function createNodeOps(h: LiveHelpers): LiveNodeOps {
  const { Fs, bridgeOf, call, metadataCall, makeNode, statOf, childPath, flushNode, truncate } = h;
  const { ensureLoaded } = h;
  const setTimes = (node: LiveFsNode, path: string, atime: number, mtime: number): void => {
    const now = Fs.sliccTouch === true;
    if (Fs.isLink(node.mode)) {
      metadataCall(() => bridgeOf(node).lutimes(path, atime, mtime, now));
      return;
    }
    flushNode(node);
    metadataCall(() => bridgeOf(node).utimes(path, atime, mtime, now));
  };
  const stamped = typeof (Fs as { doSetAttr?: unknown }).doSetAttr !== 'function';
  const timesOf = (node: LiveFsNode, attr: LiveSetAttr): [number, number] | undefined => {
    const mtime = toMs(attr.mtime) ?? (stamped ? attr.timestamp : undefined);
    const atime = toMs(attr.atime);
    if (mtime !== undefined && attr.atime !== null) return [atime ?? mtime, mtime];
    if (atime === undefined && mtime === undefined) return undefined;
    const st = statOf(node);
    return [atime ?? st.atimeMs ?? st.mtimeMs ?? 0, mtime ?? st.mtimeMs ?? 0];
  };
  return {
    getattr(node) {
      const owned = bridgeOf(node).owners === true;
      if (owned && Fs.isLink(node.mode) && statOf(node).uid === undefined)
        node.live.stat = undefined;
      const cached = owned && cachedStat(node, Fs.isDir(node.mode), bridgeOf(node).changes);
      const st = statOf(node);
      if (cached) searchParents(Fs, node, bridgeOf(node), call);
      const s = node.live;
      const size = Fs.isDir(node.mode) ? 4096 : (s.ranged?.size() ?? (s.loaded ? s.len : st.size));
      const mtime = new Date(st.mtimeMs ?? 0);
      return {
        dev: st.dev ?? 1,
        ino: st.ino ?? inodeOf(liveNodePath(node)),
        mode: node.mode,
        nlink: st.nlink ?? 1,
        uid: owned ? (st.uid ?? 0) : 0,
        gid: owned ? (st.gid ?? 0) : 0,
        rdev: 0,
        size,
        atime: new Date(st.atimeMs ?? mtime.getTime()),
        mtime,
        ctime: new Date(st.ctimeMs ?? mtime.getTime()),
        blksize: 4096,
        blocks: Math.ceil(size / 4096) * 8,
      };
    },
    setattr(node, attr) {
      if (node.live.orphan) {
        if (attr.mode !== undefined && attr.mode !== null) {
          node.mode = (node.mode & ~PERM_MASK) | (attr.mode & PERM_MASK);
        }
        if (attr.size !== undefined && attr.size !== null) truncate(node, attr.size);
        return;
      }
      const path = liveNodePath(node);
      if (attr.mode !== undefined && attr.mode !== null) {
        if (Fs.isLink(node.mode)) throw new Fs.ErrnoError(wasiErrno('EOPNOTSUPP'));
        const perm = attr.mode & PERM_MASK;
        if (perm !== (node.mode & PERM_MASK)) {
          metadataCall(() => bridgeOf(node).chmod(path, perm));
          node.mode = (node.mode & ~PERM_MASK) | perm;
        }
      }
      if (attr.size !== undefined && attr.size !== null && Fs.isFile(node.mode)) {
        truncate(node, attr.size);
      }
      const times = timesOf(node, attr);
      if (times) setTimes(node, path, ...times);
      node.live.stat = undefined;
    },
    lookup(parent, name) {
      const listed = parent.live.listed?.get(name);
      parent.live.listed?.delete(name);
      const asked = listed ? listing(parent.live) : asking(bridgeOf(parent));
      const st = listed ?? call(() => bridgeOf(parent).lstat(childPath(parent, name)));
      return answeredAt(makeNode(parent, name, st), asked);
    },
    mknod(parent, name, mode) {
      parent.live.listed = undefined;
      const path = childPath(parent, name);
      const bridge = bridgeOf(parent);
      const perm = bridge.owners ? mode & PERM_MASK : undefined;
      if (Fs.isDir(mode) && perm !== undefined) {
        call(() => bridge.mkdir(path, perm));
      } else if (Fs.isDir(mode)) {
        call(() => bridge.mkdir(path));

        const masked = mode & PERM_MASK & ~UMASK;
        if (masked !== DEFAULT_DIR_PERM) metadataCall(() => bridge.chmod(path, masked));
      } else if (Fs.isFile(mode)) {
        call(() =>
          bridge.create
            ? bridge.create(path, perm, (opening.get(h.Fs) as number) > 0)
            : bridge.writeFile(path, new Uint8Array(0))
        );
      } else if ((mode & S_IFMT) === S_IFIFO && bridge.mkfifo) {
        call(() => bridge.mkfifo?.(path, mode & PERM_MASK));
      } else {
        throw new Fs.ErrnoError(wasiErrno('EPERM'));
      }
      const node = makeNode(parent, name, {
        isFile: Fs.isFile(mode),
        ...((mode & S_IFMT) === S_IFIFO ? { isFifo: true } : {}),
        isDirectory: Fs.isDir(mode),
        isSymbolicLink: false,
        size: 0,
        mode,
        mtimeMs: Date.now(),
      });

      node.live.stat = undefined;
      if (Fs.isFile(mode)) node.live.created = true;
      return node;
    },
    rename(oldNode, newDir, newName) {
      oldNode.parent.live.listed = undefined;
      newDir.live.listed = undefined;
      const from = liveNodePath(oldNode);
      const to = childPath(newDir, newName);
      flushNode(oldNode);
      renamedOver(h, newDir, newName, oldNode, () => renameThrough(h, oldNode, from, to));
      oldNode.name = newName;
      oldNode.parent = newDir;
      oldNode.live.stat = undefined;
    },
    unlink(parent, name) {
      parent.live.listed = undefined;
      let open: LiveFsNode | undefined;
      try {
        const node = Fs.lookupNode?.(parent, name);
        if (node && node.live?.openCount > 0 && Fs.isFile(node.mode)) open = node;
      } catch {}
      const st = open && freshStat(h, open);
      if (open) {
        const ranged = h.rangedOf(open);
        if (ranged) ranged.pin();
        else ensureLoaded(open);
      }
      call(() => bridgeOf(parent).unlink(childPath(parent, name)));
      if (open && st) orphaned(h, open, st);
    },
    rmdir(parent, name) {
      parent.live.listed = undefined;
      call(() => bridgeOf(parent).rmdir(childPath(parent, name)));
    },
    readdir(node) {
      const listedAt = performance.now();
      const listedGen = bridgeOf(node).changes?.now();
      const listed = call(() => bridgeOf(node).readdirStat(liveNodePath(node)));
      node.live.listed = new Map();
      Object.assign(node.live, { listedAt, listedGen });
      for (const [name, st] of listed) if (st) node.live.listed.set(name, st);
      return ['.', '..', ...listed.map(([name]) => name)];
    },
    symlink(parent, newName, target) {
      parent.live.listed = undefined;
      const path = childPath(parent, newName);
      call(() => bridgeOf(parent).symlink(target, path));
      return makeNode(parent, newName, {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        size: new TextEncoder().encode(target).length,
      });
    },
    readlink(node) {
      if (!Fs.isLink(node.mode)) throw new Fs.ErrnoError(wasiErrno('EINVAL'));
      const bridge = bridgeOf(node);
      const path = liveNodePath(node);
      if (bridge.links && Fs.sliccReading !== node) {
        call(() => bridge.access?.(path, 0, 'follow', true));
      }
      return call(() => bridge.readlink(path));
    },
  };
}

function appendThrough(h: LiveHelpers, stream: LiveFsStream, bytes: () => Uint8Array): boolean {
  const node = stream.node;
  const s = node.live;
  const append = pinnedIo(h.bridgeOf(node), s.handle).append;
  if (!append) return false;
  const body = bytes();
  const at = liveNodePath(h.linked.holder(node));
  const after = unlessIo(() => {
    h.flushNode(node);
    return h.call(() => append(at, body));
  });
  if (after === undefined) return false;
  if (!s.ranged) {
    s.data = undefined;
    s.loaded = false;
    s.len = 0;
  }
  s.stat = undefined;
  stream.position = after - body.length;
  return true;
}

function holdLive(
  bridge: SyncFsPosixBridge,
  node: LiveFsNode,
  on: boolean,
  want: number
): number | undefined {
  const s = node.live;
  const seen =
    on && s.stat
      ? { gen: s.stat.gen, ...(s.stat.ino !== undefined ? { ino: s.stat.ino } : {}) }
      : undefined;
  return bridge.hold?.(liveNodePath(node), on, true, s.handle, want, seen);
}

function dropOpen(s: LiveNodeState): boolean {
  if (s.openCount === 0) return false;
  s.openCount -= 1;
  return true;
}

function createStreamOps(h: LiveHelpers): LiveStreamOps {
  const { Fs, statOf, ensureLoaded, ensureCapacity, flushNode, bridgeOf, rangedOf } = h;
  const held = (stream: LiveFsStream, change: 1 | -1) => heldStream(h, stream, change);

  const opened = (node: LiveFsNode, on: boolean, want = 0) => {
    const s = node.live;
    try {
      h.track(node, on);
      const handle = holdLive(bridgeOf(node), node, on, want);
      s.handle = on ? handle : undefined;
      h.linked.opening(node, on);
      if (s.handle === undefined) h.handled.delete(node);
      else h.handled.add(node);
    } catch (err) {
      if (refusal(err) || gone(err)) {
        throw new Fs.ErrnoError(wasiErrno((err as { code: string }).code));
      }
    }
  };
  const permitted = (stream: LiveFsStream, created: boolean): number => {
    const s = stream.node.live;
    const bridge = bridgeOf(stream.node);
    if (!bridge.owners || s.orphan) return 0;
    const want = wantOf(stream.flags) | (created ? HOLD_CREATED : 0);
    if (s.openCount > 0 && !created) {
      h.call(() => bridge.access?.(liveNodePath(stream.node), accessOf(want), 'open'));
    }
    return want;
  };
  const fifo = (stream: LiveFsStream) => {
    const open = h.Fs.sliccOpenFifo;
    try {
      if (!open) throw new Fs.ErrnoError(wasiErrno('ENXIO'));
      open.call(h.Fs, stream, liveNodePath(stream.node));
    } catch (err) {
      if (stream.fd !== undefined) Fs.closeStream?.(stream.fd);
      throw err;
    }
  };
  const directory = (stream: LiveFsStream) => {
    if ((stream.node.mode & S_IFMT) === S_IFIFO && !(stream.flags & O_PATH)) return fifo(stream);
    if ((stream.node.mode & S_IFMT) === S_IFSOCK && !(stream.flags & O_PATH)) {
      if (stream.fd !== undefined) Fs.closeStream?.(stream.fd);
      throw new Fs.ErrnoError(wasiErrno('ENXIO'));
    }
    const bridge = bridgeOf(stream.node);
    if (!bridge.owners || !Fs.isDir(stream.node.mode) || stream.flags & O_PATH) return;
    try {
      h.call(() =>
        bridge.access?.(liveNodePath(stream.node), accessOf(wantOf(stream.flags)), 'open')
      );
    } catch (err) {
      if (stream.fd !== undefined) Fs.closeStream?.(stream.fd);
      throw err;
    }
  };
  return {
    open(stream) {
      if (!Fs.isFile(stream.node.mode)) return directory(stream);
      const s = stream.node.live;
      const created = s.created === true;
      s.created = undefined;
      if (s.openCount === 0 && !s.orphan) {
        const bridge = bridgeOf(stream.node);
        s.ranges = !!(
          bridge.pread &&
          bridge.pwrite &&
          bridge.truncate &&
          statOf(stream.node).ranged
        );
        const shared = h.linked.sharedWith(stream.node);
        if (shared) stream.node.live = shared;
        else rangedOf(stream.node);
      }
      if ((stream.flags & 3) !== 0) {
        try {
          const st = statOf(stream.node);
          if (st.readonly) throw new Fs.ErrnoError(wasiErrno('EROFS'));
          stream.node.live.maxFile = st.maxFile;
        } catch (err) {
          if (stream.fd !== undefined) Fs.closeStream?.(stream.fd);
          throw err;
        }
      }
      const live = stream.node.live;
      let counted = false;
      try {
        const want = permitted(stream, created);
        live.openCount++;
        counted = true;
        if (live.openCount === 1) opened(stream.node, true, want);
      } catch (err) {
        if (counted) live.openCount--;
        if (stream.fd !== undefined) Fs.closeStream?.(stream.fd);
        throw err;
      }
      held(stream, 1);
    },

    dup(stream) {
      if (!Fs.isFile(stream.node.mode)) return;
      stream.node.live.openCount++;
      held(stream, 1);
    },
    close(stream) {
      const node = stream.node;
      if (!Fs.isFile(node.mode)) return;
      const s = node.live;
      if (!dropOpen(s)) return;
      h.follow(node);
      if (s.openCount > 0) {
        held(stream, -1);
        return;
      }
      try {
        flushNode(node);
      } finally {
        s.data = undefined;
        s.ranged = undefined;
        s.ranges = false;
        s.len = 0;
        s.loaded = false;
        held(stream, -1);
        h.track(node, false);
        if (s.handle !== undefined) opened(node, false);
      }
    },
    read(stream, buffer, offset, length, position) {
      const node = stream.node;
      if (Fs.isDir(node.mode)) throw new Fs.ErrnoError(wasiErrno('EISDIR'));
      h.follow(node);
      const ranged = rangedOf(node);
      if (ranged) {
        const out = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, Math.max(0, length));
        return h.call(() => ranged.readInto(position, out));
      }
      ensureLoaded(node);
      const s = node.live;
      if (position >= s.len || length <= 0) return 0;
      const n = Math.min(length, s.len - position);
      const out = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n);
      out.set((s.data as Uint8Array).subarray(position, position + n));
      return n;
    },
    write(stream, buffer, offset, length, position) {
      const node = stream.node;
      if (Fs.isDir(node.mode)) throw new Fs.ErrnoError(wasiErrno('EISDIR'));
      if (length <= 0) return 0;
      h.follow(node);
      const s = node.live;
      const end = position + length;
      if (s.maxFile !== undefined && end > s.maxFile) throw new Fs.ErrnoError(wasiErrno('EFBIG'));
      const bytes = () => new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice();
      if (stream.flags & O_APPEND && appendThrough(h, stream, bytes)) return length;
      const ranged = rangedOf(node);
      if (ranged) {
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        h.call(() => ranged.write(position, bytes));
        h.markDirty(node);
        return length;
      }
      ensureLoaded(node);
      const buf = ensureCapacity(node, end);
      if (position > s.len) buf.fill(0, s.len, position);
      buf.set(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length), position);
      s.len = Math.max(s.len, end);
      h.markDirty(node);
      return length;
    },
    llseek(stream, offset, whence) {
      let pos = offset;
      if (whence === SEEK_CUR) pos += stream.position;
      else if (whence === SEEK_END && Fs.isFile(stream.node.mode)) {
        const s = stream.node.live;
        pos += rangedOf(stream.node)?.size() ?? (s.loaded ? s.len : statOf(stream.node).size);
      }
      if (pos < 0) throw new Fs.ErrnoError(wasiErrno('EINVAL'));
      return pos;
    },
    fsync(stream) {
      h.follow(stream.node);
      flushNode(stream.node);
    },
  };
}

const opening = new WeakMap<LiveFsApi, number>();

function countOpens(Fs: LiveFsApi): void {
  const { open } = Fs;
  if (typeof open !== 'function' || opening.has(Fs)) return;
  opening.set(Fs, 0);
  Fs.open = function (this: unknown, ...args: unknown[]) {
    opening.set(Fs, (opening.get(Fs) ?? 0) + 1);
    try {
      return open.apply(this, args);
    } finally {
      opening.set(Fs, (opening.get(Fs) ?? 1) - 1);
    }
  };
}

export function createLiveVfsPlugin(Fs: LiveFsApi): LiveVfsPlugin {
  const mounts = new Set<LiveFsMount>();
  const ops: LiveOpsTables = {};
  const h = createHelpers(Fs, ops);
  countOpens(Fs);
  const nodeOps = createNodeOps(h);
  const streamOps = createStreamOps(h);
  ops.node = nodeOps;
  ops.stream = streamOps;
  return {
    mounts,
    node_ops: nodeOps,
    stream_ops: streamOps,
    handled: h.handled,
    flushDirty: () => h.flushDirty(),
    mount(mount) {
      const st = h.call(() => mount.opts.bridge.stat(mount.opts.root));
      h.watchRenames(mount.opts.bridge);
      if (!st.isDirectory) throw new Fs.ErrnoError(wasiErrno('ENOTDIR'));
      const root = h.makeNode(null, '/', st);
      root.mode = modeFromStat(st, mount.opts.bridge.owners === true);
      mounts.add(mount);
      return root;
    },
  };
}

function ownedBy(plugin: LiveVfsPlugin, node: LiveFsNode | null | undefined): node is LiveFsNode {
  return !!node?.live && plugin.mounts.has(node.mount);
}

export function flushLiveVfs(Fs: LiveFsApi, plugin: LiveVfsPlugin): void {
  for (const head of Fs.nameTable ?? []) {
    for (let node = head; node; node = (node as { name_next?: LiveFsNode }).name_next ?? null) {
      const s = node.live;
      if (!ownedBy(plugin, node) || !s.dirty || !(s.data || s.ranged)) continue;
      try {
        if (s.ranged) s.ranged.flush();
        else {
          const bytes = (s.data as Uint8Array).slice(0, s.len);
          pinnedIo(node.mount.opts.bridge, s.handle).writeFile(liveNodePath(node), bytes, true);
        }
        s.dirty = false;
      } catch (err) {
        throw toErrno(Fs, err);
      }
    }
  }
}

function refresh(s: LiveNodeState): void {
  if (s.dirty || s.orphan) return;
  if (s.ranged?.pinnedVersion !== undefined) {
    s.ranged.forget();
    return;
  }
  s.data = undefined;
  s.ranged = undefined;
  s.len = 0;
  s.loaded = false;
}

export function invalidateLiveVfs(Fs: LiveFsApi, plugin: LiveVfsPlugin): void {
  const table = Fs.nameTable ?? [];
  const drop: LiveFsNode[] = [];
  for (const head of table) {
    for (let node = head; node; node = (node as { name_next?: LiveFsNode }).name_next ?? null) {
      if (!ownedBy(plugin, node)) continue;
      const s = node.live;
      s.stat = undefined;
      s.listed = undefined;
      if (s.openCount === 0) {
        if (node !== node.mount.root && !node.mounted) drop.push(node);
      } else refresh(s);
    }
  }
  if (!Fs.hashRemoveNode) return;
  for (const node of drop) Fs.hashRemoveNode(node);
}

export interface LiveMountFsApi extends LiveFsApi {
  root?: MemfsRoot;
  rename?(from: string, to: string): void;
  lookupPath?(path: string, opts?: { follow?: boolean; parent?: boolean }): { node: object };
  sliccRename?: true;
  sliccKept?: true;
  sliccStale?: true;
  sliccVanished?: true;
  open?(path: string, flags: number, mode?: number): unknown;
  statfsNode?(node: LiveFsNode): Record<string, number>;
  sliccStatfs?: true;
  filesystems: { SLICC_LIVE_FS?: LiveVfsPlugin };
  mkdirTree(path: string): void;
  mount(type: LiveVfsPlugin, opts: LiveFsMountOpts, mountpoint: string): unknown;
}

function outermostDirs(dirs: readonly string[]): string[] {
  const norm = [...new Set(dirs.map((d) => d.replace(/\/+$/, '') || '/'))].sort();
  return norm.filter((d) => !norm.some((o) => o !== d && (o === '/' || d.startsWith(`${o}/`))));
}

function describeMountError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const errno = (err as { errno?: unknown } | null)?.errno;
  return typeof errno === 'number' ? `errno ${errno}` : String(err);
}

export function mountLiveVfsDirs(
  Fs: LiveMountFsApi,
  bridge: SyncFsPosixBridge,
  dirs: readonly string[],
  warn: (message: string) => void
): { plugin: LiveVfsPlugin; mounted: string[] } {
  if (Fs.root?.memfs) Fs.root.node_ops = Fs.root.memfs;
  if (typeof Fs.filesystems !== 'object' || !Fs.filesystems) {
    throw new Error(
      'the module was linked without filesystem support, so the VFS cannot be mounted ' +
        '(link it with -sFORCE_FILESYSTEM=1)'
    );
  }
  const plugin = Fs.filesystems.SLICC_LIVE_FS ?? createLiveVfsPlugin(Fs);
  Fs.filesystems.SLICC_LIVE_FS = plugin;
  guardStatfs(Fs);
  const mounted: string[] = [];
  for (const dir of outermostDirs(dirs)) {
    if (dir === '/') continue;
    try {
      Fs.mkdirTree(dir);
      Fs.mount(plugin, { root: dir, bridge }, dir);
      mounted.push(dir);
    } catch (err) {
      warn(`live VFS mount of ${dir} failed: ${describeMountError(err)}`);
    }
  }
  return { plugin, mounted };
}

type MemfsRoot = LiveFsNode & { contents?: Record<string, unknown>; memfs?: LiveNodeOps };

export function liveRoot(Fs: LiveMountFsApi, bridge: SyncFsPosixBridge): void {
  const root = Fs.root;
  const plugin = Fs.filesystems.SLICC_LIVE_FS;
  if (!root || !plugin) return;
  root.mount.opts = { root: '/', bridge };
  root.live = { len: 0, loaded: false, dirty: false, openCount: 0 };
  plugin.mounts.add(root.mount);
  invalidateLiveVfs(Fs, plugin);
  guardRenames(Fs);
  guardKeptNodes(Fs, plugin.handled);
  guardStaleNodes(Fs, plugin);
  guardVanished(Fs);
  guardStatfs(Fs);
  const memfs = root.memfs ?? root.node_ops;
  const live = plugin.node_ops;
  root.memfs = memfs;
  const own = (name: string) => Object.hasOwn(root.contents ?? {}, name);
  root.node_ops = {
    ...memfs,
    lookup: (parent, name) => live.lookup(parent, name),
    mknod: (parent, name, mode, dev) => live.mknod(parent, name, mode, dev),
    unlink: (parent, name) => live.unlink(parent, name),
    rmdir: (parent, name) => (own(name) ? memfs : live).rmdir(parent, name),
    symlink: (parent, name, target) => live.symlink(parent, name, target),
    rename: (node, dir, name) => (node.live ? live : memfs).rename(node, dir, name),
    readdir(node) {
      const names = new Set(memfs.readdir(node));
      for (const name of live.readdir(node)) names.add(name);
      return [...names];
    },
  };
}

function crosses(Fs: LiveMountFsApi, from: string, to: string): boolean {
  const parentOf = (path: string) =>
    Fs.lookupPath?.(path, { parent: true }).node as LiveFsNode | undefined;
  const name = from.replace(/\/+$/, '').split('/').pop() ?? '';
  try {
    const fromDir = parentOf(from);
    const node = fromDir && Fs.lookupNode?.(fromDir, name);
    const dir = parentOf(to);
    return !!node && !!dir && !!node.live !== !!dir.live;
  } catch {
    return false;
  }
}

function guardStatfs(Fs: LiveMountFsApi): void {
  const statfsNode = Fs.statfsNode?.bind(Fs);
  if (!statfsNode || Fs.sliccStatfs) return;
  Fs.sliccStatfs = true;
  Fs.statfsNode = (node) => {
    const defaults = statfsNode(node);
    let usage: SyncFsUsage | null | undefined;
    try {
      usage = node.live ? node.mount?.opts?.bridge?.statfs?.(liveNodePath(node)) : undefined;
    } catch {
      return defaults;
    }
    if (!usage) return defaults;
    const free = Math.max(0, Math.floor((usage.quota - usage.usage) / 4096));
    return {
      ...defaults,
      bsize: 4096,
      frsize: 4096,
      blocks: Math.ceil(usage.quota / 4096),
      bfree: free,
      bavail: free,
    };
  };
}

function pinnedIo(bridge: SyncFsPosixBridge, handle: number | undefined): SyncFsFileIo {
  return handle !== undefined && bridge.pinned ? bridge.pinned(handle) : bridge;
}

function guardKeptNodes(Fs: LiveMountFsApi, handled: Set<LiveFsNode> | undefined): void {
  const open = Fs.open?.bind(Fs);
  const forget = Fs.hashRemoveNode?.bind(Fs);
  if (!open || !forget || !Fs.lookupPath || !handled || Fs.sliccKept) return;
  Fs.sliccKept = true;
  const lookupPath = Fs.lookupPath.bind(Fs);
  Fs.open = (path, flags, mode) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (![...handled].some((held) => held.name === name)) return open(path, flags, mode);
    let node: LiveFsNode | undefined;
    try {
      node = lookupPath(path, { follow: true }).node as LiveFsNode;
    } catch {}
    const handle = node?.live?.openCount ? node.live.handle : undefined;
    if (node && handle !== undefined && node.mount.opts.bridge.kept?.(handle)) forget(node);
    return open(path, flags, mode);
  };
}

function outdated(node: LiveFsNode, view: ChangeView, before: number): boolean {
  const s = node.live;
  if (
    view.foreign() &&
    s.seenAt !== syncEpoch() &&
    s.openCount === 0 &&
    !s.dirty &&
    node !== node.mount.root &&
    !node.mounted
  )
    return true;
  if (s.named === undefined) {
    s.named = before;
    return false;
  }
  if (s.named === before) return false;
  const { now, changed } = view.changedSince(s.named, liveNodePath(node));
  s.named = now;
  return changed && s.openCount === 0 && !s.dirty && node !== node.mount.root && !node.mounted;
}

function guardStaleNodes(Fs: LiveMountFsApi, plugin: LiveVfsPlugin): void {
  const lookupNode = Fs.lookupNode?.bind(Fs);
  const forget = Fs.hashRemoveNode?.bind(Fs);
  if (!lookupNode || !forget || Fs.sliccStale) return;
  Fs.sliccStale = true;
  Fs.lookupNode = (parent, name) => {
    const view = parent.live ? parent.mount.opts.bridge.changes : undefined;
    const before = view?.now() ?? 0;
    const node = lookupNode(parent, name);
    if (!view || !ownedBy(plugin, node) || !outdated(node, view, before)) return node;
    forget(node);
    const fresh = lookupNode(parent, name);
    if (fresh.live) fresh.live.named = before;
    return fresh;
  };
}

const O_NOFOLLOW = 0o400000;

const RESOLVING: ReadonlyArray<[string, (args: unknown[]) => boolean]> = [
  ['open', (args) => ((args[1] as number) & O_NOFOLLOW) === 0],
  ['stat', (args) => !args[1]],
  ['lstat', () => false],
  ['unlink', () => false],
  ['rename', () => false],
  ['readlink', () => false],
  ['truncate', () => true],
];

function guardVanished(Fs: LiveMountFsApi): void {
  const forget = Fs.hashRemoveNode?.bind(Fs);
  if (!forget || !Fs.lookupPath || Fs.sliccVanished) return;
  Fs.sliccVanished = true;
  const drop: (node: LiveFsNode) => void = forget;
  const lookupPath = Fs.lookupPath.bind(Fs);
  const ops = Fs as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
  const cached = (path: string, follow: boolean): LiveFsNode | undefined => {
    try {
      const node = lookupPath(path, { follow }).node as LiveFsNode;
      return node.live && node.live.openCount === 0 && !node.live.dirty ? node : undefined;
    } catch {
      return undefined;
    }
  };
  let open: ((...args: unknown[]) => unknown) | undefined;
  for (const [name, follows] of RESOLVING) {
    const op = ops[name]?.bind(Fs);
    if (name === 'open') open = op;
    if (op) ops[name] = vanishing(op, follows);
  }
  function vanishing(
    op: (...args: unknown[]) => unknown,
    follows: (args: unknown[]) => boolean
  ): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
      try {
        return op(...args);
      } catch (err) {
        const path = args[0];
        const code = (err as { errno?: unknown }).errno;
        const taken = code === wasiErrno('EEXIST') && op === open;
        if ((code !== wasiErrno('ENOENT') && !taken) || typeof path !== 'string') throw err;
        const node = cached(path, follows(args));
        if (!node) throw err;
        drop(node);
        return op(...args);
      }
    };
  }
}

function guardRenames(Fs: LiveMountFsApi): void {
  const rename = Fs.rename?.bind(Fs);
  if (!rename || Fs.sliccRename) return;
  Fs.sliccRename = true;
  Fs.rename = (from, to) => {
    if (crosses(Fs, from, to)) throw new Fs.ErrnoError(wasiErrno('EXDEV'));
    rename(from, to);
  };
}

export interface LiveChownFs extends LiveFsApi {
  lookupPath(path: string, opts?: { follow?: boolean }): { node: object };
  chown?(path: string | object, uid: number, gid: number, dontFollow?: boolean): void;
  fchown?(fd: number, uid: number, gid: number): void;
  getStreamChecked?(fd: number): { node: object; path?: string };
}

function idOf(value: number): number | undefined {
  return value === -1 || value === 0xffffffff ? undefined : value >>> 0;
}

function chownHeld(
  Fs: LiveChownFs,
  node: LiveFsNode,
  s: LiveNodeState,
  uid: number,
  gid: number
): void {
  const bridge = node.mount.opts.bridge as SyncFsPosixBridge;
  const handle = s.handle as number;
  try {
    bridge.chown?.(liveNodePath(node), idOf(uid), idOf(gid), false, handle);
  } catch (err) {
    throw toErrno(Fs, err);
  }
  if (node.parent?.live) node.parent.live.listed = undefined;
  if (!s.orphan) {
    s.stat = undefined;
    return;
  }
  try {
    const st = bridge.keptStat?.(handle);
    if (st && s.stat) s.stat = { ...s.stat, uid: st.uid, gid: st.gid, mode: st.mode };
  } catch {}
}

export function useLiveChown(Fs: LiveChownFs): void {
  const chown = Fs.chown?.bind(Fs);
  if (!chown) return;
  Fs.chown = (path, uid, gid, dontFollow) => {
    const node = (
      typeof path === 'string' ? Fs.lookupPath(path, { follow: !dontFollow }).node : path
    ) as LiveFsNode;
    if (!node.live || node.live.orphan) return chown(path, uid, gid, dontFollow);
    try {
      node.mount.opts.bridge.chown?.(liveNodePath(node), idOf(uid), idOf(gid));
    } catch (err) {
      throw toErrno(Fs, err);
    }
    node.live.stat = undefined;
    if (node.parent?.live) node.parent.live.listed = undefined;
  };
  const { getStreamChecked } = Fs;
  if (!Fs.fchown || !getStreamChecked) return;
  Fs.fchown = (fd, uid, gid) => {
    const stream = getStreamChecked.call(Fs, fd);
    const node = stream.node as LiveFsNode;
    const s = node.live;
    if (s?.handle !== undefined && (!s.orphan || s.kept)) return chownHeld(Fs, node, s, uid, gid);
    const target = s !== undefined || stream.path === undefined ? stream.node : stream.path;
    (Fs.chown as NonNullable<LiveChownFs['chown']>)(target, uid, gid);
  };
}

export interface LiveLinkFs extends LiveFsApi {
  lookupPath(path: string, opts?: { follow?: boolean }): { node: object };
}

function flushOne(Fs: LiveFsApi, node: LiveFsNode): void {
  const s = node.live;
  if (!s.dirty || s.orphan || !(s.data || s.ranged)) return;
  try {
    if (s.ranged) s.ranged.flush();
    else {
      const bytes = (s.data as Uint8Array).slice(0, s.len);
      pinnedIo(node.mount.opts.bridge, s.handle).writeFile(liveNodePath(node), bytes, true);
    }
  } catch (err) {
    throw toErrno(Fs, err);
  }
  s.dirty = false;
  s.stat = undefined;
}

function linkable(bridge: SyncFsPosixBridge, path: string): boolean {
  try {
    return bridge.lstat(path).linkable === true;
  } catch {
    return false;
  }
}

export function linkLive(Fs: LiveLinkFs, from: string, to: string, follow: boolean): boolean {
  const target = to.replace(/\/+$/, '');
  const slash = target.lastIndexOf('/');
  const name = target.slice(slash + 1);
  const source = Fs.lookupPath(from, { follow }).node as LiveFsNode;
  const parent = Fs.lookupPath(target.slice(0, slash) || '/', { follow: true }).node as LiveFsNode;
  if (!source.live || !parent.live) return false;
  flushOne(Fs, source);
  const base = liveNodePath(parent);
  const bridge = source.mount.opts.bridge;
  const path = liveNodePath(source);
  try {
    bridge.link(path, base === '/' ? `/${name}` : `${base}/${name}`);
  } catch (err) {
    const refused = toErrno(Fs, err) as Error & { errno: number };
    if (refused.errno !== wasiErrno('EPERM') || linkable(bridge, path)) throw refused;
    throw new Fs.ErrnoError(wasiErrno('EMLINK'));
  }
  source.live.stat = undefined;
  parent.live.listed = undefined;
  return true;
}

export interface LiveReadlinkFs extends LiveFsApi {
  lookupPath(path: string, opts?: { follow?: boolean }): { node: object };
  readlink?(path: string): string;
}

export function readingLinks(Fs: LiveReadlinkFs): void {
  const readlink = Fs.readlink?.bind(Fs);
  if (!readlink) return;
  Fs.readlink = (path) => {
    const was = Fs.sliccReading;
    Fs.sliccReading = Fs.lookupPath(path).node as LiveFsNode;
    try {
      return readlink(path);
    } finally {
      Fs.sliccReading = was;
    }
  };
}
