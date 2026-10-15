import { RangedFile } from '../fs/ranged.ts';
import { inodeOf } from '../fs/types.ts';
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
import { syncCallCount } from './sync-sab-bridge.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const PERM_MASK = 0o7777;

const DEFAULT_DIR_PERM = 0o755;

const UMASK = 0o022;
const SEEK_CUR = 1;
const SEEK_END = 2;

interface LiveNodeState {
  stat?: SyncFsBridgeStat;
  statAt?: number;

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

  maxFile?: number;

  ranges?: boolean;
  ranged?: RangedFile;
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

  nameTable?: (LiveFsNode | null)[] | null;
  hashRemoveNode?(node: LiveFsNode): void;
  lookupNode?(parent: LiveFsNode, name: string): LiveFsNode;
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
  const type = st.isSymbolicLink ? S_IFLNK : st.isDirectory ? S_IFDIR : S_IFREG;
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

function cachedStat(s: LiveNodeState, dir: boolean): boolean {
  return s.stat !== undefined && (!dir || s.statAt === syncCallCount());
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

function createHelpers(Fs: LiveFsApi, ops: LiveOpsTables) {
  const bridgeOf = (node: LiveFsNode): SyncFsPosixBridge => node.mount.opts.bridge;
  const fileIo = (node: LiveFsNode): SyncFsFileIo => pinnedIo(bridgeOf(node), node.live.handle);
  const dirty = new Set<LiveFsNode>();
  const handled = new Set<LiveFsNode>();
  const linked = linkedStates(bridgeOf);

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

  function freshState(stat?: SyncFsBridgeStat): LiveNodeState {
    const statAt = syncCallCount();
    return { ...(stat ? { stat, statAt } : {}), len: 0, loaded: false, dirty: false, openCount: 0 };
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
    if (!cachedStat(node.live, Fs.isDir(node.mode))) {
      const st = call(() => bridgeOf(node).lstat(liveNodePath(linked.holder(node))));
      Object.assign(node.live, { stat: st, statAt: syncCallCount() });
      node.mode = modeFromStat(st, exactIn(node));
    }
    return node.live.stat as SyncFsBridgeStat;
  }

  function childPath(parent: LiveFsNode, name: string): string {
    const base = liveNodePath(parent);
    return base === '/' ? `/${name}` : `${base}/${name}`;
  }

  function ensureLoaded(node: LiveFsNode): void {
    const s = node.live;
    if (s.loaded) return;
    const bytes = call(() => fileIo(node).readFile(liveNodePath(linked.holder(node))));
    s.data = bytes;
    s.len = bytes.length;
    s.loaded = true;
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
    const st = call(() => bridge.stat(path()));
    s.ranged = new RangedFile(io, path(), st.size, st.version);
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
    if (s.ranged) call(() => s.ranged?.flush());
    else {
      const bytes = (s.data as Uint8Array).slice(0, s.len);
      call(() => fileIo(node).writeFile(liveNodePath(linked.holder(node)), bytes, true));
    }
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
      const st = statOf(node);
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
      const st = listed ?? call(() => bridgeOf(parent).lstat(childPath(parent, name)));
      return makeNode(parent, name, st);
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
          bridge.create ? bridge.create(path, perm) : bridge.writeFile(path, new Uint8Array(0))
        );
      } else {
        throw new Fs.ErrnoError(wasiErrno('EPERM'));
      }
      const node = makeNode(parent, name, {
        isFile: Fs.isFile(mode),
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
      call(() => bridgeOf(oldNode).rename(from, to));

      try {
        const existing = Fs.lookupNode?.(newDir, newName);
        if (existing && existing !== oldNode) Fs.hashRemoveNode?.(existing);
      } catch {}
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
      const listed = call(() => bridgeOf(node).readdirStat(liveNodePath(node)));
      node.live.listed = new Map();
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

function createStreamOps(h: LiveHelpers): LiveStreamOps {
  const { Fs, statOf, ensureLoaded, ensureCapacity, flushNode, bridgeOf, rangedOf } = h;
  const held = (stream: LiveFsStream, change: 1 | -1) => {
    const s = stream.node.live;
    if ((stream.flags & 3) === 0 || s.orphan) return;
    const before = s.writers ?? 0;
    s.writers = Math.max(0, before + change);
    if ((before === 0) !== (s.writers === 0)) {
      try {
        bridgeOf(stream.node).hold?.(liveNodePath(stream.node), s.writers > 0);
      } catch {}
    }
  };
  const opened = (node: LiveFsNode, on: boolean, want = 0) => {
    const s = node.live;
    try {
      const handle = bridgeOf(node).hold?.(liveNodePath(node), on, true, s.handle, want);
      s.handle = on ? handle : undefined;
      h.linked.opening(node, on);
      if (s.handle === undefined) h.handled.delete(node);
      else h.handled.add(node);
    } catch (err) {
      if (refusal(err)) throw new Fs.ErrnoError(wasiErrno((err as { code: string }).code));
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
  const directory = (stream: LiveFsStream) => {
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
      s.openCount = Math.max(0, s.openCount - 1);
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
        opened(node, false);
      }
    },
    read(stream, buffer, offset, length, position) {
      const node = stream.node;
      if (Fs.isDir(node.mode)) throw new Fs.ErrnoError(wasiErrno('EISDIR'));
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
      const s = node.live;
      const end = position + length;
      if (s.maxFile !== undefined && end > s.maxFile) throw new Fs.ErrnoError(wasiErrno('EFBIG'));
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
      flushNode(stream.node);
    },
  };
}

export function createLiveVfsPlugin(Fs: LiveFsApi): LiveVfsPlugin {
  const mounts = new Set<LiveFsMount>();
  const ops: LiveOpsTables = {};
  const h = createHelpers(Fs, ops);
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
    const live = (stream.node as LiveFsNode).live !== undefined;
    const target = live || stream.path === undefined ? stream.node : stream.path;
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
