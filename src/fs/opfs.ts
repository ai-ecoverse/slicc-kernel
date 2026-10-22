import { SHARED_TTL_MS } from './changes.ts';
import { MemoryMeta, type MetaEntry, type MetaStore, type MetaUpdate } from './meta.ts';
import { noticeOf } from './notice.ts';
import { chain, inherit, ownOf, ROOT_OWNER, sameOwner } from './owners.ts';
import { PathMap } from './path-map.ts';
import { holdsProtected, isProtected } from './protect.ts';
import {
  type LockManagerLike,
  lockManager,
  type PeerRename,
  RENAME_ACK_MAX_MS,
  type RemoteChange,
  type RemoteListener,
  RemoteWatch,
} from './remote.ts';
import {
  type CopyOptions,
  type FsStat,
  fsError,
  inodeOf,
  type KernelFs,
  type NewOwner,
  normalizePath,
  type Owner,
  type OwnerChange,
  type Peers,
  type Perm,
  redirected,
  resolvePath,
} from './types.ts';
import { view } from './view.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;
const S_IFIFO = 0o010000;
const PERM_MASK = 0o7777;
const S_ISGID = 0o2000;
const READ_ATTEMPTS = 3;

async function swapped<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if ((err as { name?: unknown })?.name !== 'NotFoundError' || attempt >= READ_ATTEMPTS) {
        throw err;
      }
    }
  }
}
const MAX_LINKS = 40;
const CHECK_MS = 1000;
const ABSENT_MS = 2;
const GLANCE_MS = 2;
const ABSENT_NAMES = 4096;
const FILE_HANDLES = 4096;
const STALE: ReadonlySet<string> = new Set(['NotFoundError', 'TypeMismatchError']);
const REPLACED_ATTEMPTS = 4;
const RECONCILE_LISTINGS = 8;
const EXECUTABLE = /\/node_modules\/(?:@[^/]+\/)?[^/]+\/bin\//;

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface MovableHandle {
  move?(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
}

const RENAMES = '/.slicc-renames';
const RENAME_LOCK = 'slicc-rename:';
const RENAME_ADMIT = 'slicc-rename-admit:';
const escapeRoot = (name: string): string =>
  name.replace(/[%:]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const LEGACY_RENAME_LOCK =
  /^slicc-rename:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAIRED = new Set(['rename', 'link', 'copyFile']);
const LISTINGS = new Set(['readdir', 'readdirStat']);
const REMOVALS = new Set(['rm', 'rename']);
const RETRY = Symbol('retry');
const ACK_SAMPLES = 4096;
const INTENT_POLL_MS = 5;

interface Inflight {
  paths: readonly string[];
  removing?: boolean;
  waiting?: { promise: Promise<void>; resolve: () => void };
  release: () => void;
}

interface PeerMove {
  lock: string;
  trees: Array<[string, string]>;
  done?: true;
}

type Copies = Map<string, { before: number; made: FileSystemFileHandle }>;

function movable(handle: Handle): boolean {
  return typeof (handle as Handle & MovableHandle).move === 'function';
}

interface Located {
  path: string;
  handle?: Handle;
  link?: MetaEntry;
}

const ERRNO_BY_DOM_ERROR: Readonly<Record<string, string>> = {
  NotFoundError: 'ENOENT',
  TypeMismatchError: 'ENOTDIR',
  InvalidModificationError: 'ENOTEMPTY',
  NoModificationAllowedError: 'EBUSY',
  TypeError: 'EINVAL',
  NotAllowedError: 'EACCES',
};

export type OpfsOp = 'lookup' | 'read' | 'write' | 'commit' | 'sidecar';

const reported = new Set<string>();

export function translate(err: unknown, path: string, op: OpfsOp = 'lookup', mapped = true): Error {
  if (typeof (err as { code?: unknown })?.code === 'string') return err as Error;
  const raw = (err as { name?: unknown })?.name;
  const name = typeof raw === 'string' ? raw : 'Error';
  const code =
    name === 'QuotaExceededError' ? 'ENOSPC' : (mapped && ERRNO_BY_DOM_ERROR[name]) || 'EIO';
  const error = Object.assign(fsError(code, path), { domName: name, op, cause: err });
  if (code !== 'EIO' && code !== 'ENOSPC') return error;
  const detail = (err as { message?: unknown })?.message;
  error.message += ` (OPFS ${op}: ${name}${typeof detail === 'string' && detail ? `: ${detail}` : ''})`;
  if (!reported.has(`${name}/${op}`)) {
    reported.add(`${name}/${op}`);
    console.warn(
      `slicc-kernel: ${error.message}, reported as ${code}; logged once per error and operation`
    );
  }
  return error;
}

const META_OPS = ['get', 'update', 'move', 'remove', 'links', 'under', 'all'] as const;

type MetaOp = (typeof META_OPS)[number] | 'fresh';

function sidecar(meta: MetaStore): MetaStore {
  const pathOf = ([first]: unknown[]) =>
    [first, '/'].flat().find((p): p is string => typeof p === 'string') as string;
  const guarded =
    (op: MetaOp) =>
    (...args: unknown[]) =>
      (meta[op] as (...args: unknown[]) => Promise<unknown>)
        .apply(meta, args)
        .catch((err: unknown) => {
          throw translate(err, pathOf(args), 'sidecar', false);
        });
  const names = meta.fresh ? [...META_OPS, 'fresh' as const] : META_OPS;
  const ops = Object.fromEntries(names.map((op) => [op, guarded(op)])) as unknown as MetaStore;
  const { updateMany } = meta;
  ops.updateMany = updateMany
    ? (changes) =>
        updateMany.call(meta, changes).catch((err: unknown) => {
          throw translate(err, changes[0]?.path ?? '/', 'sidecar', false);
        })
    : async (changes) => {
        for (const { path, change } of changes) await ops.update(path, change);
      };
  if (meta.absent) ops.absent = meta.absent.bind(meta);
  if (meta.forgetTrees) ops.forgetTrees = meta.forgetTrees.bind(meta);
  const { removeFile } = meta;
  if (removeFile)
    ops.removeFile = (path: string) =>
      removeFile.call(meta, path).catch((err: unknown) => {
        throw translate(err, path, 'sidecar', false);
      });
  return ops;
}

function occupied(entry: MetaEntry | undefined): Partial<MetaEntry> {
  if (!entry?.vacated) return entry ?? {};
  const { vacated: _, ...kept } = entry;
  return kept;
}

function vacatedAt(path: string): MetaEntry {
  return { path, ino: inodeOf(`${path}\0${crypto.randomUUID()}`), vacated: true };
}

function missing(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function prefixes(path: string): string[] {
  const parts = split(path);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

interface Positioned {
  write(at: number, bytes: Uint8Array): unknown;
  truncate(size: number): unknown;
}

interface SyncAccess {
  write(bytes: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
  getSize?(): number;
}

const unstored = () =>
  Object.assign(new Error('the file system kept fewer bytes than were written'), {
    code: 'ENOSPC',
  });

const CHECKED_BYTES = 16 * 1024 * 1024;

class Extent {
  floor = 0;
  exact: number | undefined;

  wrote(end: number): void {
    this.floor = Math.max(this.floor, end);
    if (this.exact !== undefined) this.exact = Math.max(this.exact, end);
  }

  cut(size: number): void {
    this.exact = size;
    this.floor = Math.min(this.floor, size);
  }

  big(): boolean {
    return Math.max(this.floor, this.exact ?? 0) >= CHECKED_BYTES;
  }

  check(size: number): void {
    if (size < this.floor || (this.exact !== undefined && size < this.exact)) throw unstored();
  }
}

type SyncCapable = FileSystemFileHandle & {
  createSyncAccessHandle?(options?: { mode?: string }): Promise<SyncAccess>;
};

const LOCKED = new Set(['NotReadableError', 'NoModificationAllowedError', 'InvalidStateError']);

const SYNC_BACKOFF_MS = [5, 10, 20, 40, 80];

async function openSync(handle: FileSystemFileHandle): Promise<SyncAccess | undefined> {
  const sync = (handle as SyncCapable).createSyncAccessHandle;
  if (!sync) return undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await sync.call(handle, { mode: 'readwrite-unsafe' });
    } catch (err) {
      const delay = SYNC_BACKOFF_MS[attempt];
      if (!LOCKED.has((err as { name?: unknown })?.name as string)) throw err;
      if (delay === undefined) return undefined;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function writeAll(access: SyncAccess, at: number, bytes: Uint8Array): void {
  for (let done = 0; done < bytes.length; ) {
    const n = access.write(bytes.subarray(done), { at: at + done });
    if (!(n > 0))
      throw Object.assign(new Error('the file system took no more bytes'), { code: 'ENOSPC' });
    done += n;
  }
}

async function positioned(handle: FileSystemFileHandle, op: (io: Positioned) => unknown) {
  const extent = new Extent();
  const access = await openSync(handle);
  if (access) {
    try {
      op({
        write: (at, bytes) => {
          writeAll(access, at, bytes);
          extent.wrote(at + bytes.length);
        },
        truncate: (n) => {
          access.truncate(n);
          extent.cut(n);
        },
      });
      access.flush();
      if (access.getSize) extent.check(access.getSize());
    } finally {
      access.close();
    }
    return;
  }
  const writable = await handle.createWritable({ keepExistingData: true });
  try {
    await op({
      write: async (at, bytes) => {
        await writable.write({
          type: 'write',
          position: at,
          data: bytes as Uint8Array<ArrayBuffer>,
        });
        extent.wrote(at + bytes.length);
      },
      truncate: async (n) => {
        await writable.truncate(n);
        extent.cut(n);
      },
    });
  } catch (err) {
    await writable.abort();
    throw err;
  }
  await writable.close();
  if (extent.big()) extent.check((await handle.getFile()).size);
}

export interface WriteSession {
  write(at: number, bytes: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}

export function syncAccessHandles(scope: object = globalThis): boolean {
  const handle = (scope as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  return handle !== undefined && 'createSyncAccessHandle' in handle.prototype;
}

function isHandle(child: Handle | MetaEntry): child is Handle {
  return 'kind' in child;
}

export const FILE_TIMES_MS = 100;

export class OpfsFs implements KernelFs {
  private readonly root: FileSystemDirectoryHandle;
  private readonly meta: MetaStore;
  private readonly dirs = new PathMap<FileSystemDirectoryHandle>();
  private readonly files = new PathMap<FileSystemFileHandle>();
  private readonly absent = new PathMap<number>();
  private changes = 0;
  private replacing: Promise<void> = Promise.resolve();
  private replacements = 0;
  private readonly glances = new WeakMap<
    FileSystemFileHandle,
    { at: number; file: File; changes: number }
  >();
  private readonly found = new WeakMap<FileSystemFileHandle, number>();
  private readonly checked = new WeakMap<FileSystemDirectoryHandle, number>();

  private readonly channel: BroadcastChannel | undefined;
  private readonly remote: RemoteWatch | undefined;
  private readonly ranged: boolean;
  private owners = false;
  private rejectLinks = false;
  private readonly mounts: { mounted?: (path: string) => boolean } = {};
  private readonly locks: LockManagerLike | undefined;
  private readonly lockPrefix: string;
  readonly rootName: string | undefined;
  private readonly renamePrefix: string;

  constructor(
    root: FileSystemDirectoryHandle,
    meta: MetaStore = new MemoryMeta(),
    channel?: string,
    options: { ranged?: boolean; locks?: LockManagerLike | null } = {}
  ) {
    this.root = root;
    this.meta = sidecar(meta);
    this.ranged = options.ranged === true;
    this.locks = options.locks === undefined ? lockManager() : (options.locks ?? undefined);
    this.lockPrefix = `slicc-excl:${channel ?? ''}:`;
    this.rootName = channel;
    this.renamePrefix = `${RENAME_LOCK}${escapeRoot(channel ?? '')}:`;
    this.channel = channel === undefined ? undefined : new BroadcastChannel(channel);
    this.remote =
      channel === undefined
        ? undefined
        : new RemoteWatch(`${channel}:watch`, { locks: this.locks ?? null });
    if (this.remote) {
      this.remote.quiet = () => this.quiet().then(() => this.settle?.());
      this.remote.gone = () => {
        void this.orphans();
        for (const move of [...this.peerMoves.values()]) void this.peerMoved(move);
      };
      this.remote.renaming = (rename) => this.heardRename(rename);
      this.remote.renamed = (lock) => {
        const move = this.peerMoves.get(lock);
        if (!move) return;
        move.done = true;
        void this.peerMoved(move);
      };
    }
    if (this.channel) {
      const remote = this.remote;
      (meta as { listen?: (l: (c: Partial<RemoteChange>) => void) => void }).listen?.((c) => {
        for (const path of [...(c.paths ?? []), ...(c.trees ?? [])]) this.forget(path);
        const moved = movedOf(c.moved);
        remote?.emit({ paths: c.paths ?? [], trees: c.trees ?? [], ...(moved ? { moved } : {}) });
      });
      remote?.listen((c) => {
        for (const path of [...c.paths, ...c.trees]) this.forget(path);
      });
      this.channel.onmessage = ({ data }) => {
        const { paths, trees, outside } = noticeOf(data);
        for (const path of [...paths, ...trees]) this.forget(normalizePath(path));
        const tell = () => remote?.emit({ paths, trees });
        if (!outside) tell();
        else void this.noticed(paths.map(normalizePath), Date.now()).finally(tell);
      };
      (this.channel as BroadcastChannel & { unref?: () => void }).unref?.();
    }
  }

  private changed(...paths: string[]): void {
    for (const path of paths) this.forget(path);
    this.channel?.postMessage(paths);
  }

  remoteChanges(listener: RemoteListener): () => void {
    return this.remote?.listen(listener) ?? (() => {});
  }

  announceWatch(paths: readonly string[]): Promise<void> {
    return this.remote?.announce(paths) ?? Promise.resolve();
  }

  private committed(target: string): void {
    this.fileTimes.delete(target);
    if (this.remote?.watched() || this.remote?.crowded()) this.remote.wrote(target);
  }

  private counted: readonly string[] = [];

  private async stamp(path: string, cached = false): Promise<string> {
    const paths = [path, '/'];
    const [entry, root] =
      this.meta.fresh && !cached ? await this.meta.fresh(paths) : await this.meta.get(paths);
    return `${entry?.writes ?? 0}:${root?.epoch ?? 0}`;
  }

  private async epoch(): Promise<void> {
    await this.meta.update('/', (entry) => ({
      ...entry,
      path: '/',
      epoch: (entry?.epoch ?? 0) + 1,
    }));
  }

  private async entering(path: string, change: () => Promise<void>): Promise<void> {
    if (!isProtected(this.counted, path) && !holdsProtected(this.counted, path)) return change();
    await this.epoch();
    try {
      await change();
    } finally {
      await this.epoch();
    }
  }

  private async counting(target: string): Promise<void> {
    if (!isProtected(this.counted, target)) return;
    await this.meta.update(target, (entry) => ({
      ...entry,
      path: target,
      writes: (entry?.writes ?? 0) + 1,
    }));
  }

  private async recounting(handle: FileSystemFileHandle, target: string): Promise<void> {
    if (this.counted.length === 0) return;
    const where = await this.io(this.root.resolve(handle)).catch(() => null);
    await this.counting(where ? `/${where.join('/')}` : target);
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  trackOwners(): void {
    this.owners = true;
  }

  crossings(mounted: (path: string) => boolean): void {
    this.mounts.mounted = mounted;
  }

  private crossing(of: string, to: string): void {
    if (this.mounts.mounted?.(to)) throw redirected(of, to);
  }

  async hasOwner(path: string): Promise<boolean> {
    return ownOf((await this.meta.get([path]))[0]) !== undefined;
  }

  async ancestry(path: string): Promise<Perm[]> {
    const entries = await this.meta.get(chain(path));
    const out: Perm[] = [];
    for (const [i, entry] of entries.entries()) {
      const link = entry?.link !== undefined && !(await this.real(entry.path));
      out.push({
        ...(ownOf(entry) ?? (i === 0 ? ROOT_OWNER : inherit(entries.slice(0, i)))),
        ...(entry?.mode !== undefined ? { mode: entry.mode } : {}),
        ...(link ? { link: entry.link } : {}),
      });
    }
    return out;
  }

  private async handedTo(dir: string): Promise<Owner> {
    return inherit(await this.meta.get(chain(dir)));
  }

  private async ownerAt(path: string, entry: MetaEntry | undefined): Promise<Owner> {
    const own = ownOf(entry);
    if (own) return own;
    return path === '/' ? { ...ROOT_OWNER } : this.handedTo(parentOf(path));
  }

  private async owned(stat: FsStat, path: string, entry: MetaEntry | undefined): Promise<FsStat> {
    return this.owners ? { ...stat, ...(await this.ownerAt(path, entry)) } : stat;
  }

  private async newFields(
    path: string,
    owner: NewOwner | undefined,
    directory: boolean
  ): Promise<Partial<MetaEntry> | undefined> {
    if (!this.owners || !owner) return undefined;
    const entries = await this.meta.get(chain(path));
    const self = entries.pop();
    const parent = entries.at(-1);
    const setgid = ((parent?.mode ?? 0) & S_ISGID) !== 0;
    const parentGid = (ownOf(parent) ?? inherit(entries.slice(0, -1))).gid;
    const want = { uid: owner.uid, gid: setgid ? parentGid : owner.gid };
    let mode = owner.mode === undefined ? undefined : owner.mode & PERM_MASK;
    if (directory && setgid) mode = (mode ?? 0o755) | S_ISGID;
    const fields: Partial<MetaEntry> = {};
    if (mode !== undefined && mode !== (this.mode(path, directory, undefined) & PERM_MASK)) {
      fields.mode = mode;
    }
    if (self) fields.heir = undefined;
    if (ownOf(self) || !sameOwner(want, inherit(entries))) Object.assign(fields, want);
    return Object.keys(fields).length > 0 ? fields : undefined;
  }

  private async stampNew(path: string, owner: NewOwner | undefined, directory: boolean) {
    const owned = await this.newFields(path, owner, directory);
    if (owner?.socket && owner.fifo) throw new Error('a new node is a socket or a FIFO, not both');
    const kind = directory
      ? undefined
      : owner?.socket
        ? 'socket'
        : owner?.fifo
          ? 'fifo'
          : undefined;
    const unique = kind === 'fifo' ? { ino: inodeOf(`${path}\0${crypto.randomUUID()}`) } : {};
    const fields = kind ? { ...owned, ...unique, [kind]: true as const } : owned;
    if (fields) await this.meta.update(path, (entry) => ({ ...occupied(entry), path, ...fields }));
  }

  private guarded: readonly string[] = [];

  protect(prefixes: readonly string[], versions = false): void {
    this.guarded = prefixes;
    this.counted = versions ? prefixes : [];
  }

  unguarded(): KernelFs {
    return view(this, { guarded: [] }) as unknown as KernelFs;
  }

  noLinks(): KernelFs {
    return view(this, { rejectLinks: true }) as unknown as KernelFs;
  }

  private refuse(path: string, holding = false): void {
    if (isProtected(this.guarded, path) || (holding && holdsProtected(this.guarded, path))) {
      throw fsError('EROFS', path);
    }
  }

  private unlocked = 0;
  private idle: Array<() => void> = [];

  private async alone<T>(op: () => Promise<T>): Promise<T> {
    this.unlocked++;
    try {
      return await op();
    } finally {
      this.unlocked--;
      if (this.unlocked === 0) for (const done of this.idle.splice(0)) done();
    }
  }

  private settle: (() => Promise<void>) | undefined;

  onPeer(settle: () => Promise<void>): void {
    this.settle = settle;
  }

  peers(): Peers | undefined {
    const remote = this.remote;
    if (!remote) return undefined;
    return {
      joined: () => remote.peered(),
      crowded: () => remote.crowded(),
      watch: (listener) => {
        remote.crowd = (crowded) => {
          this.fresh();
          listener(crowded);
        };
        listener(remote.crowded());
      },
      fresh: () => this.fresh(),
    };
  }

  private quiet(): Promise<void> {
    if (this.unlocked === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idle.push(resolve));
  }

  private async locked<T>(physicalPath: string, op: () => Promise<T>): Promise<T> {
    if (!this.locks) return op();
    if (this.remote && !(await this.remote.peered())) return this.alone(op);
    const key = `${this.lockPrefix}${physicalPath}`;
    let result!: T;
    await this.locks.request(key, async () => {
      result = await op();
    });
    return result;
  }

  async chown(path: string, change: OwnerChange): Promise<void> {
    if (!this.owners) return;
    if (change.kind === 'new') {
      const at = resolvePath((await this.locate(parentOf(path), true)).path, baseOf(path));
      this.refuse(at);
      const { uid = 0, gid = 0, mode } = change;
      return this.stampNew(at, { uid, gid, ...(mode !== undefined ? { mode } : {}) }, false);
    }
    const found = await this.locate(path, change.follow !== false);
    this.refuse(found.path);
    const [stored] = found.link ? [found.link] : await this.meta.get([found.path]);
    const current = await this.ownerAt(found.path, stored);
    const next = { uid: change.uid ?? current.uid, gid: change.gid ?? current.gid };
    const handing = found.handle?.kind === 'directory' && !sameOwner(next, current);
    const heir =
      change.kind === 'adopt'
        ? undefined
        : (stored?.heir ??
          (handing ? ([current.uid, current.gid] as [number, number]) : undefined));
    const ctimeMs = Date.now();
    await this.meta.update(found.path, (entry) => {
      const { heir: _, ...rest } = entry ?? found.link ?? { path: found.path };
      return {
        ...rest,
        path: found.path,
        ...next,
        ...(heir ? { heir } : {}),
        ...(change.mode !== undefined ? { mode: change.mode & PERM_MASK } : {}),
        ctimeMs,
      };
    });
  }

  private async movedOwner(source: Located): Promise<Owner | undefined> {
    if (!this.owners) return undefined;
    const [stored] = source.link ? [source.link] : await this.meta.get([source.path]);
    return ownOf(stored) ? undefined : this.ownerAt(source.path, stored);
  }

  private async walk(parts: string[], from: number, start: FileSystemDirectoryHandle) {
    let dir = start;
    for (let at = from; at < parts.length; at++) {
      this.calls++;
      dir = await dir.getDirectoryHandle(parts[at] as string);
      this.dirs.set(`/${parts.slice(0, at + 1).join('/')}`, dir);
      this.checked.set(dir, performance.now());
    }
    return dir;
  }

  private async dir(path: string): Promise<FileSystemDirectoryHandle> {
    const parts = split(path);
    let from = parts.length;
    let cached: FileSystemDirectoryHandle | undefined;
    for (; from > 0 && !cached; from--)
      cached = this.dirs.get(`/${parts.slice(0, from).join('/')}`);
    if (cached) from++;
    const at = `/${parts.slice(0, from).join('/')}`;
    if (cached && !(await this.current(at, cached))) {
      this.forget(at);
      cached = undefined;
      from = 0;
    }
    try {
      return await this.walk(parts, from, cached ?? this.root);
    } catch (err) {
      throw translate(err, path);
    }
  }

  private async current(path: string, dir: FileSystemDirectoryHandle): Promise<boolean> {
    if (dir === this.root) return path === '/';
    if (performance.now() - (this.checked.get(dir) ?? -CHECK_MS) < CHECK_MS) return true;
    this.calls++;
    const where = await this.root.resolve(dir).catch(() => null);
    if (where === null || `/${where.join('/')}` !== path) return false;
    this.checked.set(dir, performance.now());
    return true;
  }

  private exact = 0;
  private calls = 0;
  private others = 0;

  opfsCalls(): number {
    return this.calls;
  }

  opfsOps(): number {
    return this.calls + this.others;
  }

  private io<T>(request: Promise<T>): Promise<T> {
    this.others++;
    return request;
  }

  private fresh(): void {
    this.changes++;
    this.absent.clear();
  }

  private async exactly<T>(op: () => Promise<T>): Promise<T> {
    this.exact++;
    try {
      return await op();
    } finally {
      this.exact--;
    }
  }

  private forget(path: string): void {
    this.changes++;
    this.dirs.deleteTree(path);
    this.files.deleteTree(path);
    this.absent.deleteTree(path);
  }

  private missed(path: string): void {
    if (this.absent.size >= ABSENT_NAMES) this.absent.clear();
    this.absent.set(path, performance.now());
  }

  private remember(path: string, handle: Handle, looked = false): Handle {
    if (handle.kind !== 'file') {
      if (looked) {
        this.dirs.set(path, handle as FileSystemDirectoryHandle);
        this.checked.set(handle as FileSystemDirectoryHandle, performance.now());
      }
      return handle;
    }
    if (looked) {
      this.found.set(handle as FileSystemFileHandle, performance.now());
      this.glances.delete(handle as FileSystemFileHandle);
    }
    this.files.delete(path);
    if (this.files.size >= FILE_HANDLES)
      this.files.delete(this.files.keys().next().value as string);
    this.files.set(path, handle as FileSystemFileHandle);
    return handle;
  }

  private async inDir<T>(path: string, op: (dir: FileSystemDirectoryHandle) => Promise<T>) {
    const dir = await this.dir(path);
    try {
      return await op(dir);
    } catch (err) {
      if ((err as { name?: unknown })?.name !== 'NotFoundError' || (await this.current(path, dir)))
        throw err;
      this.forget(path);
      return op(await this.dir(path));
    }
  }

  private async child(
    parent: FileSystemDirectoryHandle,
    name: string,
    kind: 'file' | 'directory'
  ): Promise<Handle> {
    this.calls++;
    return kind === 'file' ? parent.getFileHandle(name) : parent.getDirectoryHandle(name);
  }

  private async parent(path: string): Promise<[string, string]> {
    const parts = split(path);
    const name = parts.pop();
    if (name === undefined) throw fsError('EBUSY', path);
    return [`/${parts.join('/')}`, name];
  }

  private async handle(path: string): Promise<Handle> {
    if (split(path).length === 0) return this.root;
    const cached = this.files.get(path);
    const fresh = cached && performance.now() - (this.found.get(cached) ?? -CHECK_MS) < CHECK_MS;
    if (cached && !fresh) this.files.delete(path);
    if (cached && fresh) {
      if (this.glanced(cached)) return this.remember(path, cached);
      try {
        await this.glance(cached);
        return this.remember(path, cached);
      } catch (err) {
        if (!STALE.has((err as { name?: string })?.name as string))
          throw translate(err, path, 'read');
        this.files.delete(path);
        this.glances.delete(cached);
      }
    }
    const kept = this.dirs.get(path);
    if (kept && (await this.current(path, kept))) return kept;
    const gone = this.absent.get(path);
    if (gone !== undefined && this.exact === 0 && performance.now() - gone < ABSENT_MS) {
      throw translate({ name: 'NotFoundError' }, path);
    }
    const seen = this.changes;
    const [dir, name] = await this.parent(path);
    const known = kept !== undefined;
    return this.inDir(dir, async (parent): Promise<Handle> => {
      const [first, second] = known
        ? (['directory', 'file'] as const)
        : (['file', 'directory'] as const);
      try {
        return this.remember(path, await this.child(parent, name, first), true);
      } catch (err) {
        if ((err as { name?: unknown })?.name !== 'TypeMismatchError') throw err;
      }
      return this.remember(path, await this.child(parent, name, second), true);
    }).catch((err) => {
      const error = translate(err, path) as Error & { code?: string };
      if (error.code === 'ENOENT' && seen === this.changes) this.missed(path);
      throw error;
    });
  }

  private real(path: string): Promise<boolean> {
    return this.handle(path).then(
      () => true,
      () => false
    );
  }

  private async linkAlong(path: string): Promise<MetaEntry | undefined> {
    for (const entry of await this.meta.get(prefixes(path))) {
      if (entry?.link === undefined) continue;
      if (entry.path !== path && (await this.real(entry.path))) continue;
      if (await this.real(parentOf(entry.path))) return entry;
    }
    return undefined;
  }

  private locate(path: string, follow: boolean): Promise<Located> {
    return this.unreplaced(() => this.located(path, follow));
  }

  private async unreplaced<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const seen = this.replacements;
      try {
        return await op();
      } catch (err) {
        if (attempt >= REPLACED_ATTEMPTS || !missing(err)) throw err;
        await this.replacing;
        if (this.replacements === seen) throw err;
      }
    }
  }

  private async located(path: string, follow: boolean): Promise<Located> {
    let current = path;
    for (let hops = 0; hops <= MAX_LINKS; hops++) {
      try {
        return { path: current, handle: await this.handle(current) };
      } catch (err) {
        if (!missing(err)) throw err;
        const link = await this.linkAlong(current);
        if (!link) throw err;
        if (link.path === current && !follow) return { path: current, link };
        if (this.rejectLinks) throw fsError('ELOOP', path);
        const target = `${link.link}${current.slice(link.path.length)}`;
        if (target.split('/').includes('..')) {
          const resolved = await this.physical(parentOf(link.path), target, hops + 1, path);
          current = resolved.path;
          hops = resolved.hops - 1;
        } else {
          current = resolvePath(parentOf(link.path), target);
        }
        this.crossing(path, current);
      }
    }
    throw fsError('ELOOP', path);
  }

  private async physical(
    base: string,
    path: string,
    used: number,
    of: string
  ): Promise<{ path: string; hops: number }> {
    let done: string[] = [];
    let todo = (path.startsWith('/') ? path : `${base}/${path}`)
      .split('/')
      .filter((p) => p !== '' && p !== '.');
    let hops = used;
    while (todo.length > 0) {
      const part = todo.shift() as string;
      if (part === '..') done.pop();
      else if (!todo.includes('..')) done.push(part);
      else {
        const at = `/${[...done, part].join('/')}`;
        this.crossing(of, [at, ...todo].join('/'));
        const st = await this.lstat(at);
        if (!st.isSymbolicLink && !st.isDirectory) throw fsError('ENOTDIR', at);
        if (!st.isSymbolicLink) done.push(part);
        else if (this.rejectLinks) throw fsError('ELOOP', of);
        else if (++hops > MAX_LINKS) throw fsError('ELOOP', path);
        else {
          const link = await this.readlink(at);
          if (link.startsWith('/')) done = [];
          todo = [...link.split('/').filter((p) => p !== '' && p !== '.'), ...todo];
        }
      }
    }
    return { path: `/${done.join('/')}`, hops };
  }

  private mode(path: string, directory: boolean, meta: MetaEntry | undefined): number {
    const fallback = directory || EXECUTABLE.test(path) ? 0o755 : 0o644;
    const type = directory ? S_IFDIR : meta?.socket ? S_IFSOCK : meta?.fifo ? S_IFIFO : S_IFREG;
    return type | (meta?.mode ?? fallback);
  }

  private readonly id = crypto.randomUUID();
  private readonly dirTimes = new Map<string, number>();
  private readonly dirDirty = new Set<string>();
  private readonly fileTimes = new Map<string, number>();

  private written(target: string): void {
    this.committed(target);
    if (!this.ranged) return;
    this.fileTimes.set(target, Date.now());
    this.scheduleFileTimes();
  }

  private async noticed(paths: readonly string[], at: number): Promise<void> {
    for (const path of new Set(paths)) {
      const st = await this.lstat(path).catch(() => undefined);
      if (!st?.isFile || st.mtime.getTime() >= at) continue;
      this.fileTimes.set(path, Math.max(at, this.fileTimes.get(path) ?? 0));
    }
    this.scheduleFileTimes();
  }

  private scheduleFileTimes(): void {
    if (this.flushing.file || this.fileTimes.size === 0) return;
    this.flushing.file = setTimeout(() => {
      void this.flushFileTimes()
        .catch(() => undefined)
        .finally(() => {
          this.flushing.file = undefined;
          this.scheduleFileTimes();
        });
    }, FILE_TIMES_MS);
    (this.flushing.file as { unref?: () => void }).unref?.();
  }

  private async flushFileTimes(): Promise<void> {
    const pending = [...this.fileTimes];
    const stamps: number[] = [];
    for (const [path] of pending) stamps.push(await this.modified(path).catch(() => 0));
    await this.batched(
      pending.map(([path, ms], i) => ({
        path,
        change: (entry: MetaEntry | undefined) =>
          this.fileTimes.get(path) !== ms || this.explicitWins(entry, ms)
            ? entry
            : { ...entry, path, mtimeMs: ms, mtimeFor: stamps[i] as number, ctimeMs: ms },
      }))
    );
    for (const [path, ms] of pending)
      if (this.fileTimes.get(path) === ms) this.fileTimes.delete(path);
  }

  private batched(changes: MetaUpdate[]): Promise<void> {
    return (this.meta.updateMany as NonNullable<MetaStore['updateMany']>)(changes);
  }

  private timesOf(path: string): number | undefined {
    return this.dirTimes.get(path) ?? this.fileTimes.get(path);
  }

  private explicitWins(entry: MetaEntry | undefined, ms: number): boolean {
    if (entry?.timesAt === undefined || entry.timesBy === this.id) return false;
    return entry.timesAt >= ms;
  }

  private movePending(from: string, to?: string): void {
    if (to !== undefined) {
      for (const path of [...this.fileTimes.keys()]) {
        if (within(path, to)) this.fileTimes.delete(path);
      }
    }
    for (const [path, ms] of [...this.fileTimes]) {
      if (!within(path, from)) continue;
      this.fileTimes.delete(path);
      if (to !== undefined) this.fileTimes.set(to + path.slice(from.length), ms);
    }
  }

  private readonly flushing: {
    dir?: Promise<void> | undefined;
    file?: ReturnType<typeof setTimeout> | undefined;
  } = {};

  private touch(now: number, ...dirs: string[]): void {
    this.changes++;
    if (this.shared()) this.channel?.postMessage(dirs);
    for (const dir of dirs) {
      this.absent.deleteTree(dir);
      this.dirTimes.set(dir, now);
      this.dirDirty.add(dir);
    }
    this.flushing.dir ??= Promise.resolve()
      .then(() => this.flushDirTimes())
      .catch(() => undefined)
      .finally(() => {
        this.flushing.dir = undefined;
      });
  }

  private async flushDirTimes(): Promise<void> {
    while (this.dirDirty.size > 0) {
      const pending: Array<[string, number]> = [];
      for (const path of this.dirDirty) {
        const ms = this.dirTimes.get(path);
        if (ms !== undefined) pending.push([path, ms]);
      }
      this.dirDirty.clear();
      await this.batched(
        pending.map(([path, ms]) => ({
          path,
          change: (entry: MetaEntry | undefined) =>
            (entry?.timesAt ?? -1) >= ms
              ? entry
              : { ...entry, path, mtimeMs: ms, mtimeFor: 0, ctimeMs: ms },
        }))
      );
      for (const [path, ms] of pending)
        if (this.dirTimes.get(path) === ms) this.dirTimes.delete(path);
    }
  }

  private shared(): boolean {
    return this.remote?.crowded() === true;
  }

  private glanced(handle: FileSystemFileHandle): File | undefined {
    if (this.exact > 0) return undefined;
    const seen = this.glances.get(handle);
    const fresh = seen && seen.changes === this.changes && performance.now() - seen.at < GLANCE_MS;
    return fresh ? seen.file : undefined;
  }

  private async glance(handle: FileSystemFileHandle): Promise<File> {
    const at = performance.now();
    const before = this.changes;
    this.calls++;
    const file = await handle.getFile();
    if (before === this.changes) this.glances.set(handle, { at, file, changes: before });
    else this.glances.delete(handle);
    return file;
  }

  private wrote(handle: FileSystemFileHandle): void {
    this.changes++;
    this.glances.delete(handle);
  }

  private async snapshot(handle: FileSystemFileHandle): Promise<File> {
    return this.glanced(handle) ?? this.glance(handle);
  }

  private async statOf(
    path: string,
    handle: Handle,
    meta: MetaEntry | undefined,
    touched: number | undefined
  ): Promise<FsStat> {
    const directory = handle.kind === 'directory';
    const file = directory ? undefined : await this.snapshot(handle as FileSystemFileHandle);
    const modified = file?.lastModified ?? 0;
    const kept =
      meta?.mtimeMs !== undefined && meta.mtimeFor === modified ? meta.mtimeMs : modified;
    const mtime = touched ?? kept;
    const socket = !directory && meta?.socket === true;
    const fifo = !directory && meta?.fifo === true;
    return {
      isFile: !directory && !socket && !fifo,
      isDirectory: directory,
      isSymbolicLink: false,
      ...(socket ? { isSocket: true } : {}),
      ...(fifo ? { isFifo: true } : {}),
      size: file?.size ?? 0,
      mode: this.mode(path, directory, meta),
      mtime: new Date(mtime),
      atime: new Date(meta?.atimeMs ?? mtime),
      ctime: new Date(Math.max(touched ?? meta?.ctimeMs ?? mtime, modified)),
      ino: meta?.ino ?? inodeOf(path),
      ...(this.ranged && !directory ? { ranged: true } : {}),
    };
  }

  private linkStat(entry: MetaEntry): FsStat {
    const time = new Date(entry.mtimeMs ?? 0);
    return {
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
      size: new TextEncoder().encode(entry.link).length,
      mode: S_IFLNK | 0o777,
      mtime: time,
      atime: entry.atimeMs === undefined ? time : new Date(entry.atimeMs),
      ctime: new Date(entry.ctimeMs ?? 0),
      ino: entry.ino ?? inodeOf(entry.path),
    };
  }

  private async describe(found: Located): Promise<FsStat> {
    const stat = await this.described(found);
    return isProtected(this.guarded, found.path) ? { ...stat, readonly: true } : stat;
  }

  private async described(found: Located): Promise<FsStat> {
    if (found.link) return this.owned(this.linkStat(found.link), found.path, found.link);
    const touched = this.timesOf(found.path);
    if (!this.owners) {
      const [meta] = await this.meta.get([found.path]);
      return this.statOf(found.path, found.handle as Handle, meta, touched);
    }
    const entries = await this.meta.get(chain(found.path));
    const meta = entries.pop();
    const stat = await this.statOf(found.path, found.handle as Handle, meta, touched);
    return { ...stat, ...(ownOf(meta) ?? inherit(entries)) };
  }

  stat(path: string): Promise<FsStat> {
    return this.unreplaced(() =>
      swapped(async () => this.describe(await this.located(path, true)))
    );
  }

  lstat(path: string): Promise<FsStat> {
    return this.unreplaced(() =>
      swapped(async () => this.describe(await this.located(path, false)))
    );
  }

  async exists(path: string): Promise<boolean> {
    return this.locate(path, true).then(
      () => true,
      (err: unknown) => {
        if (missing(err)) return false;
        throw err;
      }
    );
  }

  private async retrying<T>(path: string, op: () => Promise<T>, locks: boolean): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const name = (err as { name?: unknown })?.name;
        const again = name === 'NotReadableError' || (locks && LOCKED.has(name as string));
        if (!again || attempt >= READ_ATTEMPTS)
          throw translate(err, path, locks ? 'write' : 'read');
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
      }
    }
  }

  private reading<T>(path: string, op: (handle: FileSystemFileHandle) => Promise<T>): Promise<T> {
    return this.unreplaced(async () => {
      for (let attempt = 1; ; attempt++) {
        const found = await this.locate(path, true);
        const handle = found.handle as Handle;
        if (handle.kind === 'directory') throw fsError('EISDIR', path);
        try {
          return await this.retrying(path, () => op(handle), false);
        } catch (err) {
          if ((err as { code?: unknown }).code !== 'ENOENT' || attempt >= READ_ATTEMPTS) throw err;
          this.files.delete(found.path);
        }
      }
    });
  }

  private async existing(path: string, writing = false): Promise<FileSystemFileHandle> {
    const found = await this.locate(path, true);
    if (writing) this.refuse(found.path);
    const handle = found.handle as Handle;
    if (handle.kind === 'directory') throw fsError('EISDIR', path);
    return handle;
  }

  private async refuseNode(path: string, empty: boolean): Promise<void> {
    if (!empty) return;
    const [entry] = await this.meta.get([(await this.locate(path, true)).path]);
    if (entry?.fifo || entry?.socket) throw fsError('ENXIO', path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const bytes = await this.reading(
      path,
      async (handle) => new Uint8Array(await (await this.io(handle.getFile())).arrayBuffer())
    );
    await this.refuseNode(path, bytes.length === 0);
    return bytes;
  }

  async readVersioned(
    path: string,
    cached = false
  ): Promise<{ bytes: Uint8Array; version: string }> {
    return this.reading(path, async (handle) => {
      const stamp = await this.stamp(path, cached);
      const file = await this.io(handle.getFile());
      const bytes = new Uint8Array(await file.arrayBuffer());
      await this.refuseNode(path, bytes.length === 0);
      return { bytes, version: `${file.lastModified}:${file.size}:${stamp}` };
    });
  }

  async version(path: string, cached = false): Promise<string> {
    return this.reading(path, async (handle) => {
      const stamp = await this.stamp(path, cached);
      const file = await this.io(handle.getFile());
      return `${file.lastModified}:${file.size}:${stamp}`;
    });
  }

  async pread(path: string, offset: number, length: number): Promise<Uint8Array> {
    return this.reading(path, async (handle) => {
      const file = await this.io(handle.getFile());
      await this.refuseNode(path, file.size === 0);
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    });
  }

  async pwrite(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    const at = normalizePath(path);
    const movedAway = this.renamesInFlight() ? await this.writeWaits(at) : false;
    this.fileWrites.set(at, (this.fileWrites.get(at) ?? 0) + 1);
    try {
      const [kept, target, existed] = await this.keptFor(path);
      if (kept) {
        try {
          await this.writeAt(kept, target, path, offset, bytes);
          return;
        } catch (err) {
          if ((err as { code?: string }).code !== 'ENOENT') throw err;
          this.files.delete(target);
        }
      }
      const [handle] = await this.fileFor(path, !existed && !movedAway);
      await this.writeAt(handle, target, path, offset, bytes);
    } finally {
      this.writeEnded(at);
    }
  }

  private async keptFor(
    path: string
  ): Promise<[FileSystemFileHandle | undefined, string, boolean]> {
    const at = normalizePath(path);
    const cached = this.files.get(at);
    const fresh = cached && performance.now() - (this.found.get(cached) ?? -CHECK_MS) < CHECK_MS;
    const [target, existed] = fresh ? [at, true] : await this.writeTarget(path);
    if (!existed) return [undefined, target, false];
    this.refuse(target);
    const [entry] = await this.meta.get([target]);
    if (entry?.fifo || entry?.socket) throw fsError('ENXIO', path);
    const kept = fresh ? cached : this.files.get(target);
    const usable = kept && performance.now() - (this.found.get(kept) ?? -CHECK_MS) < CHECK_MS;
    return [usable ? kept : undefined, target, true];
  }

  private async writeAt(
    handle: FileSystemFileHandle,
    target: string,
    path: string,
    offset: number,
    bytes: Uint8Array
  ): Promise<void> {
    await this.counting(target);
    this.wrote(handle);
    try {
      await this.retrying(
        path,
        () => this.io(positioned(handle, (io) => io.write(offset, bytes))),
        true
      );
    } finally {
      this.wrote(handle);
      await this.recounting(handle, target);
    }
    this.written(target);
  }

  private readonly fileWrites = new Map<string, number>();
  private readonly movingFiles = new Map<string, Promise<void>>();
  private writesIdle: PromiseWithResolvers<void> | undefined;

  private writeBlocked(at: string): { done: Promise<void>; away: boolean } | undefined {
    const file = this.movingFiles.get(at);
    if (file !== undefined) return { done: file, away: true };
    for (const m of this.renamingDirs) {
      if (within(at, m.from)) return { done: m.done, away: true };
      if (within(at, m.to)) return { done: m.done, away: false };
    }
    return undefined;
  }

  private renamesInFlight(): boolean {
    return this.movingFiles.size > 0 || this.renamingDirs.size > 0;
  }

  private async writeWaits(at: string): Promise<boolean> {
    let away = false;
    for (let busy = this.writeBlocked(at); busy !== undefined; busy = this.writeBlocked(at)) {
      away ||= busy.away;
      await busy.done;
    }
    return away;
  }

  private writeEnded(at: string): void {
    const left = (this.fileWrites.get(at) ?? 1) - 1;
    if (left > 0) this.fileWrites.set(at, left);
    else this.fileWrites.delete(at);
    const idle = this.writesIdle;
    if (idle === undefined) return;
    this.writesIdle = undefined;
    idle.resolve();
  }

  private async writesDrained(tree: string): Promise<void> {
    while ([...this.fileWrites.keys()].some((at) => within(at, tree))) {
      this.writesIdle ??= Promise.withResolvers<void>();
      await this.writesIdle.promise;
    }
  }

  private async movingFile<T>(path: string, op: () => Promise<T>): Promise<T> {
    const { promise, resolve } = Promise.withResolvers<void>();
    while (this.movingFiles.has(path)) await this.movingFiles.get(path);
    this.movingFiles.set(path, promise);
    try {
      await this.writesDrained(path);
      return await op();
    } finally {
      this.movingFiles.delete(path);
      resolve();
    }
  }

  async truncate(path: string, size: number): Promise<void> {
    const at = normalizePath(path);
    if (this.renamesInFlight()) await this.writeWaits(at);
    this.fileWrites.set(at, (this.fileWrites.get(at) ?? 0) + 1);
    try {
      await this.truncated(path, size);
    } finally {
      this.writeEnded(at);
    }
  }

  private async truncated(path: string, size: number): Promise<void> {
    const handle = await this.existing(path, true);
    await this.refuseNode(path, (await this.io(handle.getFile())).size === 0);
    const resolve = this.ranged || this.remote?.watched();
    const target = resolve || this.counted.length > 0 ? (await this.locate(path, true)).path : path;
    await this.counting(target);
    this.wrote(handle);
    try {
      await this.retrying(path, () => this.io(positioned(handle, (io) => io.truncate(size))), true);
    } finally {
      this.wrote(handle);
      await this.recounting(handle, target);
    }
    this.written(target);
  }

  async writeSession(path: string, truncate: boolean): Promise<WriteSession> {
    const [handle, , target] = await this.fileFor(path);
    const writable = await this.retrying(
      path,
      () => this.io(handle.createWritable({ keepExistingData: !truncate })),
      true
    );
    return {
      write: (at, bytes) =>
        writable
          .write({ type: 'write', position: at, data: bytes as Uint8Array<ArrayBuffer> })
          .catch((err: unknown) => {
            throw translate(err, path, 'write', false);
          }),
      truncate: (size) =>
        writable.truncate(size).catch((err: unknown) => {
          throw translate(err, path, 'write', false);
        }),
      close: async () => {
        this.wrote(handle);
        await writable.close().catch((err: unknown) => {
          this.wrote(handle);
          throw translate(err, path, 'commit', false);
        });
        this.wrote(handle);
        this.committed(target);
      },
    };
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  private async writeTarget(path: string): Promise<[string, boolean]> {
    const [target, existed] = await this.locateWrite(path);
    this.refuse(target);
    return [target, existed];
  }

  private async locateWrite(path: string): Promise<[string, boolean]> {
    try {
      return [(await this.locate(path, true)).path, true];
    } catch (err) {
      if (!missing(err)) throw err;
    }
    const [entry] = await this.meta.get([path]);
    const wanted = entry?.link === undefined ? path : resolvePath(parentOf(path), entry.link);
    return [resolvePath((await this.locate(parentOf(wanted), true)).path, baseOf(wanted)), false];
  }

  private async fileFor(
    path: string,
    create = true
  ): Promise<[FileSystemFileHandle, boolean, string]> {
    const [target, existed] = await this.writeTarget(path);
    if (!existed && !create) throw fsError('ENOENT', path);
    if (existed) {
      const [entry] = await this.meta.get([target]);
      if (entry?.fifo || entry?.socket) throw fsError('ENXIO', path);
    }
    const [dir, name] = await this.parent(target);
    try {
      const handle = await this.inDir(dir, (parent) =>
        this.io(parent.getFileHandle(name, { create }))
      );
      if (!existed) this.touch(Date.now(), parentOf(target));
      return [handle, existed, target];
    } catch (err) {
      const code = (err as { name?: unknown })?.name === 'TypeMismatchError' ? 'EISDIR' : null;
      throw code ? fsError(code, path) : translate(err, path);
    }
  }

  async writeFile(path: string, content: Uint8Array | string, owner?: NewOwner): Promise<void> {
    const [file, existed, target] = await this.fileFor(path);
    if (!existed) await this.stampNew(target, owner, false);
    if (!existed && content.length === 0) return;
    let writable: FileSystemWritableFileStream | undefined;
    this.wrote(file);
    try {
      writable = await this.io(file.createWritable());
      await writable.write(content as FileSystemWriteChunkType);
      await writable.close();
      if (typeof content !== 'string' && content.length >= CHECKED_BYTES) {
        const extent = new Extent();
        extent.cut(content.length);
        extent.check((await file.getFile()).size);
      }
    } catch (err) {
      await writable?.abort().catch(() => undefined);
      throw translate(err, path, 'commit', false);
    } finally {
      this.wrote(file);
    }
    this.committed(target);
  }

  private async listing(path: string): Promise<[string, Array<[string, Handle | MetaEntry]>]> {
    const found = await this.locate(path, true);
    const handle = found.handle as Handle;
    if (handle.kind !== 'directory') throw fsError('ENOTDIR', path);
    const children = new Map<string, Handle | MetaEntry>();
    this.others++;
    for await (const child of handle.values()) children.set(child.name, child);
    for (const link of await this.meta.links(found.path)) {
      const name = baseOf(link.path);
      if (!children.has(name)) children.set(name, link);
    }
    return [found.path, [...children].sort(([a], [b]) => (a < b ? -1 : 1))];
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.listing(path))[1].map(([name]) => name);
  }

  async readdirStat(path: string): Promise<Array<[string, FsStat | null]>> {
    const [dir, children] = await this.listing(path);
    const base = dir === '/' ? '' : dir;
    const touched = children.map(([name]) => this.timesOf(`${base}/${name}`));
    const metas = await this.meta.get(children.map(([name]) => `${base}/${name}`));
    const handed = this.owners ? await this.handedTo(dir) : undefined;
    const owned = (stat: FsStat, entry: MetaEntry | undefined): FsStat =>
      handed ? { ...stat, ...(ownOf(entry) ?? handed) } : stat;
    return Promise.all(
      children.map(async ([name, child], i): Promise<[string, FsStat | null]> => {
        if (!isHandle(child)) return [name, owned(this.linkStat(child), child)];
        const stat = await this.statOf(`${base}/${name}`, child, metas[i], touched[i]).catch(
          () => null
        );
        return [name, stat && owned(stat, metas[i])];
      })
    );
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; owner?: NewOwner } = {}
  ): Promise<void> {
    if (!options.recursive) return this.mkdirExcl(path, options.owner);
    let found: Located | undefined;
    try {
      found = await this.exactly(() => this.locate(path, true));
    } catch (err) {
      if (!missing(err)) throw err;
    }
    if (found) {
      const directory = found.handle?.kind === 'directory';
      if (directory) return;
      throw fsError('ENOTDIR', path);
    }
    const [entry] = await this.meta.get([path]);
    if (entry?.link !== undefined) throw fsError('EEXIST', path);
    const { owner } = options;
    const mode = owner?.parents;
    const above = owner && {
      uid: owner.uid,
      gid: owner.gid,
      ...(mode !== undefined ? { mode, parents: mode } : {}),
    };
    await this.mkdir(parentOf(path), { recursive: true, ...(above ? { owner: above } : {}) });
    const parent = await this.locate(parentOf(path), true);
    if (parent.handle?.kind !== 'directory') throw fsError('ENOTDIR', path);
    this.refuse(resolvePath(parent.path, baseOf(path)));
    await this.io(parent.handle.getDirectoryHandle(baseOf(path), { create: true }));
    const now = Date.now();
    const made = `${parent.path === '/' ? '' : parent.path}/${baseOf(path)}`;
    await this.stampNew(made, owner, true);
    this.touch(now, parent.path, made);
  }

  private async mkdirExcl(path: string, owner?: NewOwner): Promise<void> {
    if (normalizePath(path) === '/') throw fsError('EEXIST', path);
    const parent = await this.locate(parentOf(path), true);
    if (parent.handle?.kind !== 'directory') throw fsError('ENOTDIR', path);
    const dir = parent.handle;
    const name = baseOf(path);
    const physical = resolvePath(parent.path, name);
    await this.locked(physical, async () => {
      if (await this.handleExists(dir, name)) throw fsError('EEXIST', path);
      const freshMeta = this.meta.fresh
        ? await this.meta.fresh([path])
        : await this.meta.get([path]);
      const found = freshMeta[0];
      if (found?.link !== undefined) throw fsError('EEXIST', path);
      if (found !== undefined && !found.vacated) await this.meta.remove([path]);
      this.forget(physical);
      this.refuse(physical);
      await this.io(dir.getDirectoryHandle(name, { create: true }));
      const now = Date.now();
      const made = `${parent.path === '/' ? '' : parent.path}/${name}`;
      await this.stampNew(made, owner, true);
      this.touch(now, parent.path, made);
    });
  }

  async createExclusive(path: string, owner?: NewOwner): Promise<void> {
    if (normalizePath(path) === '/') throw fsError('EEXIST', path);
    const parent = await this.locate(parentOf(path), true);
    if (parent.handle?.kind !== 'directory') throw fsError('ENOTDIR', path);
    const dir = parent.handle;
    const name = baseOf(path);
    const physical = resolvePath(parent.path, name);
    await this.locked(physical, async () => {
      if (await this.handleExists(dir, name)) throw fsError('EEXIST', path);
      const freshMeta = this.meta.fresh
        ? await this.meta.fresh([path])
        : await this.meta.get([path]);
      const found = freshMeta[0];
      if (found?.link !== undefined) throw fsError('EEXIST', path);
      if (found !== undefined && !found.vacated) await this.meta.remove([path]);
      this.forget(physical);
      this.refuse(physical);
      const handle = await this.io(dir.getFileHandle(name, { create: true }));
      const now = Date.now();
      const made = `${parent.path === '/' ? '' : parent.path}/${name}`;
      this.remember(made, handle, true);
      await this.stampNew(made, owner, false);
      this.touch(now, parent.path, made);
    });
  }

  private async handleExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    this.calls++;
    try {
      await dir.getDirectoryHandle(name);
      return true;
    } catch (err) {
      if ((err as { name?: unknown })?.name === 'TypeMismatchError') return true;
      if ((err as { name?: unknown })?.name === 'NotFoundError') return false;
      throw err;
    }
  }

  async rm(
    path: string,
    options: { recursive?: boolean; force?: boolean; file?: boolean } = {}
  ): Promise<void> {
    let found: Located;
    try {
      found = await this.locate(path, false);
    } catch (err) {
      const error = translate(err, path) as Error & { code: string };
      if (options.force && error.code === 'ENOENT') return;
      throw error;
    }
    if (options.file && found.handle?.kind === 'directory') throw fsError('EISDIR', path);
    this.refuse(found.path, true);
    if (found.handle) {
      const [dir, name] = await this.parent(found.path);
      try {
        await this.inDir(dir, (parent) =>
          this.io(parent.removeEntry(name, { recursive: options.recursive === true }))
        );
      } catch (err) {
        throw translate(err, path);
      }
      const now = Date.now();
      const file = found.handle.kind === 'file';
      if (!file || this.remote?.watched()) this.changed(found.path);
      else this.forget(found.path);
      this.movePending(found.path);
      if (file && this.meta.absent?.(found.path)) {
        this.touch(now, parentOf(found.path));
        return;
      }
      if (file && this.meta.removeFile) {
        await this.meta.removeFile(found.path);
        this.touch(now, parentOf(found.path));
        return;
      }
    }
    await this.meta.remove(
      [found.path],
      found.handle?.kind === 'directory' ? vacatedAt(found.path) : undefined
    );
    this.touch(Date.now(), parentOf(found.path));
  }

  links(): boolean {
    return false;
  }

  async link(from: string, to: string, follow?: boolean): Promise<void> {
    await (follow ? this.stat(from) : this.lstat(from));
    if (!(await this.stat(parentOf(to))).isDirectory) throw fsError('ENOTDIR', to);
    const taken = await this.exactly(() => this.lstat(to)).then(
      () => true,
      (err) => {
        if (missing(err)) return false;
        throw err;
      }
    );
    if (taken) throw fsError('EEXIST', to);
    throw fsError('EPERM', `${from}: this file system has no hard links`);
  }

  async rename(from: string, to: string): Promise<void> {
    const call = this.renameCall;
    this.renameCall = undefined;
    if (from === to) return;
    for (;;) {
      try {
        return await this.renameOnce(from, to, call);
      } catch (err) {
        if (err !== RETRY) throw err;
      }
    }
  }

  private async renameOnce(from: string, to: string, call?: Inflight): Promise<void> {
    const source = await this.locate(from, false);
    this.refuse(source.path, true);
    this.forget(source.path);
    const parent = await this.locate(parentOf(to), true);
    const destination = resolvePath(parent.path, baseOf(to));
    this.refuse(destination, true);
    await this.entering(destination, () => this.moveTo(source, parent, destination, to, call));
  }

  private async moveTo(
    source: Located,
    parent: Located,
    destination: string,
    to: string,
    call?: Inflight
  ) {
    const sourceStat = await this.describe(source);
    if (sourceStat.isDirectory && within(destination, source.path)) throw fsError('EINVAL', to);
    const target = await this.exactly(() => this.locate(destination, false)).catch((err) => {
      if (missing(err)) return null;
      throw err;
    });
    const targetStat = target && (await this.describe(target));
    if (targetStat?.isDirectory && !sourceStat.isDirectory) throw fsError('EISDIR', to);
    if (targetStat && !targetStat.isDirectory && sourceStat.isDirectory) {
      throw fsError('ENOTDIR', to);
    }
    if (targetStat?.isDirectory && (await this.readdir(destination)).length > 0) {
      throw fsError('ENOTEMPTY', to);
    }
    const now = Date.now();
    const moving = await this.movedOwner(source);
    const carry = (entry: MetaEntry | undefined): MetaEntry => ({
      ino: inodeOf(source.path),
      ...occupied(entry),
      ...moving,
      path: destination,
      ctimeMs: now,
    });
    const left = vacatedAt(source.path);
    if (source.link) {
      if (target?.handle) await this.rm(destination);
      await this.meta.move(source.path, destination, carry, left);
      this.touch(Date.now(), parentOf(source.path), parent.path);
      return;
    }
    const dir = parent.handle as FileSystemDirectoryHandle;
    const name = baseOf(destination);
    const swap = targetStat?.isDirectory === true;
    let lock: string | undefined;
    const hooks: { notify?: () => void; started?: () => Promise<void> } = {};
    const staging = swap ? `.${name}.${crypto.randomUUID()}` : name;
    const copying = sourceStat.isDirectory && !movable(source.handle as Handle);
    const staged = resolvePath(parent.path, staging);
    const place = async () => {
      this.forget(destination);
      const copies: Copies = new Map();
      const root = { ino: inodeOf(source.path), ...moving };
      const owned = lock ? { lock } : {};
      hooks.notify?.();
      const first = copying
        ? await this.intend({ from: source.path, to: staged, root, ...owned })
        : undefined;
      const second =
        copying && swap
          ? await this.intend({ from: staged, to: destination, replace: true, root, ...owned })
          : undefined;
      await hooks.started?.().catch(async (err: unknown) => {
        for (const intent of [first, second]) {
          if (intent) await this.meta.update(intent, () => undefined);
        }
        throw err;
      });
      const moved = await this.replacingTarget(targetStat !== null, () =>
        this.place(source.handle as Handle, dir, staging, copies)
      ).catch(async (err) => {
        if (first) await this.rollBack(staged, source.path, [first, second]);
        throw err;
      });
      if (swap) await this.rm(destination, { recursive: true });
      if (second) await this.intend({ from: staged, to: destination, root, ...owned }, second);
      await this.meta.move(source.path, destination, carry, left);
      this.movePending(source.path, destination);
      if (!moved) {
        await this.rm(source.path, { recursive: true });
        await this.meta.update(source.path, () => left);
      }
      if (first) await this.meta.update(first, () => undefined);
      if (swap) {
        const hidden = await dir.getDirectoryHandle(staging);
        const placed = await this.place(hidden, dir, name, copies);
        if (!placed) await dir.removeEntry(staging, { recursive: true });
      }
      if (second) await this.meta.update(second, () => undefined);
      await this.restamp(destination, copies);
      this.changed(source.path, destination);
      this.touch(Date.now(), parentOf(source.path), parent.path);
    };
    if (!copying) return sourceStat.isDirectory ? place() : this.movingFile(source.path, place);
    const { promise, resolve } = Promise.withResolvers<void>();
    const entry = { from: source.path, to: destination, done: promise };
    this.renamingDirs.add(entry);
    try {
      await this.writesDrained(source.path);
      const locks = this.locks;
      if (locks) {
        lock = `${this.renameLocks()}${crypto.randomUUID()}`;
        this.ownLocks.add(lock);
        call?.release();
        await this.admitted(locks, lock, source.path, destination, place, hooks);
      } else await place();
    } finally {
      if (lock) this.ownLocks.delete(lock);
      this.renamingDirs.delete(entry);
      resolve();
    }
  }

  private async admitted(
    locks: LockManagerLike,
    lock: string,
    from: string,
    to: string,
    place: () => Promise<void>,
    hooks: { notify?: () => void; started?: () => Promise<void> }
  ): Promise<void> {
    const remote = this.remote;
    if (remote && !this.shared() && !(await remote.joinedAll(RENAME_ACK_MAX_MS))) {
      this.ackBusy++;
      console.warn(
        `slicc-kernel: renaming ${from} to ${to} gave up (EBUSY): a tab sharing the root did not finish joining in ${RENAME_ACK_MAX_MS} ms (#1140)`
      );
      throw fsError('EBUSY', from);
    }
    if (!remote || !this.shared()) {
      await locks.request(lock, place);
      return;
    }
    let clash: PeerMove | undefined;
    let run: Promise<unknown> | undefined;
    await locks.request(`${RENAME_ADMIT}${this.rootName ?? ''}`, async () => {
      if (await this.renamingElsewhere()) await this.learnRenames();
      clash = this.clashing(from, to);
      if (clash) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      let told: Promise<string[]> | undefined;
      hooks.notify = () => {
        told = remote.renamingTree({ from, to, lock });
      };
      hooks.started = async () => {
        resolve();
        this.renameAcks++;
        const at = performance.now();
        const stuck = await (told as Promise<string[]>);
        this.ackMs.push(performance.now() - at);
        if (this.ackMs.length > ACK_SAMPLES) this.ackMs.shift();
        if (stuck.length === 0) return;
        this.ackBusy++;
        console.warn(
          `slicc-kernel: renaming ${from} to ${to} gave up (EBUSY): peer tab ${stuck.join(', ')} is alive but did not answer in ${RENAME_ACK_MAX_MS} ms (#1140)`
        );
        throw fsError('EBUSY', from);
      };
      run = locks.request(lock, async () => {
        await place();
        remote.renamedTree(lock);
      });
      await Promise.race([promise, run.then(nothing, nothing)]);
    });
    if (clash) {
      this.peerWaited++;
      await this.peerMoved(clash);
      throw RETRY;
    }
    await run;
  }

  private renameAcks = 0;
  private ackBusy = 0;
  private readonly ackMs: number[] = [];
  private readonly ownLocks = new Set<string>();
  private readonly peerMoves = new Map<string, PeerMove>();
  private readonly peerWaits = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Inflight>();
  private renameCall: Inflight | undefined;
  private looking: Promise<void> | undefined;
  private lookedAt = Number.NEGATIVE_INFINITY;

  private peerWaited = 0;
  private queries = 0;

  renameWaits(): NonNullable<ReturnType<NonNullable<KernelFs['renameWaits']>>> {
    return {
      acks: this.renameAcks,
      busy: this.ackBusy,
      waits: this.peerWaited,
      queries: this.queries,
      ackMs: this.ackMs,
    };
  }

  private notePeer(lock: string, tree: [string, string]): PeerMove {
    let known = this.peerMoves.get(lock);
    if (!known) {
      known = { lock, trees: [] };
      this.peerMoves.set(lock, known);
    }
    if (!known.trees.some(([a, b]) => a === tree[0] && b === tree[1])) known.trees.push(tree);
    return known;
  }

  private renameLocks(): string {
    return this.renamePrefix;
  }

  private renameHere(name: string | undefined): boolean {
    if (name === undefined) return false;
    return name.startsWith(this.renameLocks()) || LEGACY_RENAME_LOCK.test(name);
  }

  private async learnRenames(): Promise<void> {
    for (const { rename } of await this.meta.under(RENAMES)) {
      if (rename?.lock === undefined || this.ownLocks.has(rename.lock)) continue;
      this.notePeer(rename.lock, [rename.from, rename.to]);
    }
  }

  private async renamingElsewhere(): Promise<boolean> {
    const { held = [] } = await (this.locks as LockManagerLike).query();
    return held.some(({ name }) => this.renameHere(name) && !this.ownLocks.has(name as string));
  }

  private lookForRenames(): Promise<void> {
    const locks = this.locks;
    const age = performance.now() - this.lookedAt;
    if (!locks || age < SHARED_TTL_MS / 2) return Promise.resolve();
    this.looking ??= (async () => {
      for (;;) {
        const asked = performance.now();
        this.queries++;
        const { held = [] } = await locks.query();
        const unknown = () =>
          held.some(
            ({ name }) =>
              this.renameHere(name) &&
              !this.ownLocks.has(name as string) &&
              !this.peerMoves.has(name as string)
          );
        if (unknown()) await this.learnRenames();
        if (!unknown()) {
          this.lookedAt = asked;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, INTENT_POLL_MS));
      }
    })().finally(() => {
      this.looking = undefined;
    });
    if (age >= SHARED_TTL_MS) return this.looking;
    this.looking.catch(nothing);
    return Promise.resolve();
  }

  private async heardRename({ from, to, lock }: PeerRename): Promise<void> {
    if (this.ownLocks.has(lock)) return;
    this.notePeer(lock, [from, to]);
    this.lookedAt = performance.now();
    const trees: Array<[string, string]> = [[from, to]];
    const running = [...this.inflight];
    const reached = await Promise.all(
      running.map(async (op) => {
        const near = (at: string) => touches(at, trees, true, op.removing === true);
        if (op.paths.some(near)) return true;
        for (const at of op.paths) {
          const forms = await this.resolvedForms(at);
          if (forms.some(near)) return true;
        }
        return false;
      })
    );
    const busy = running.filter((op, i) => reached[i] && this.inflight.has(op));
    if (this.aloneCalls > 0) {
      this.aloneDrain ??= Promise.withResolvers<void>();
      busy.push({ paths: [], waiting: this.aloneDrain, release: nothing });
    }
    await Promise.all(
      busy.map((op) => {
        op.waiting ??= Promise.withResolvers<void>();
        return op.waiting.promise;
      })
    );
  }

  private peerAt(at: string, listing: boolean, removing = false): PeerMove | undefined {
    for (const move of this.peerMoves.values()) {
      if (this.ownLocks.has(move.lock)) continue;
      if (touches(at, move.trees, listing, removing)) return move;
    }
    return undefined;
  }

  private clashing(from: string, to: string): PeerMove | undefined {
    for (const move of this.peerMoves.values()) {
      for (const tree of move.trees) {
        for (const mine of [from, to]) {
          if (tree.some((theirs) => within(mine, theirs) || within(theirs, mine))) return move;
        }
      }
    }
    return undefined;
  }

  private peerMoved(move: PeerMove): Promise<void> {
    const locks = this.locks as LockManagerLike;
    let wait = this.peerWaits.get(move.lock);
    if (wait !== undefined) return wait;
    wait = (async () => {
      if (!move.done)
        await locks.request(move.lock, async () => {
          if (move.done) return;
          const left = (await this.meta.under(RENAMES))
            .filter((entry) => entry.rename?.lock === move.lock)
            .sort(byIntent);
          for (const entry of left) await this.finishRename(entry);
        });
      this.peerMoves.delete(move.lock);
      for (const [from, to] of move.trees) {
        this.forget(from);
        this.forget(to);
        this.meta.forgetTrees?.([from, to]);
      }
    })().finally(() => this.peerWaits.delete(move.lock));
    this.peerWaits.set(move.lock, wait);
    return wait;
  }

  private async peerSettled(at: string, listing: boolean, removing: boolean): Promise<string[]> {
    await this.lookForRenames();
    for (let reals: string[] | undefined; ; ) {
      const forms = [at, ...(reals ?? [])];
      const move = forms.map((form) => this.peerAt(form, listing, removing)).find(Boolean);
      if (move) {
        this.peerWaited++;
        await this.peerMoved(move);
        continue;
      }
      if (reals !== undefined || at === '/' || this.peerMoves.size === 0) return forms;
      reals = await this.resolvedForms(at);
      if (reals.length === 0) return forms;
    }
  }

  private aloneCalls = 0;
  private aloneDrain: { promise: Promise<void>; resolve: () => void } | undefined;

  async alonePlain(
    inner: (...args: unknown[]) => Promise<unknown>,
    args: unknown[]
  ): Promise<unknown> {
    this.aloneCalls++;
    try {
      return await inner.apply(this, args);
    } finally {
      this.aloneCalls--;
      if (this.aloneCalls === 0 && this.aloneDrain) {
        this.aloneDrain.resolve();
        this.aloneDrain = undefined;
      }
    }
  }

  private async resolvedForms(at: string): Promise<string[]> {
    if (at === '/') return [];
    const parent = await PLAIN.realpath.call(this, parentOf(at), true).catch(() => parentOf(at));
    const named = resolvePath(parent, baseOf(at));
    const target = await PLAIN.realpath.call(this, at, true).catch(() => named);
    return [...new Set([named, target])].filter((form) => form !== at);
  }

  amongPeers(): boolean {
    return this.remote !== undefined && this.locks !== undefined && this.shared();
  }

  async peerOp(
    name: string,
    args: unknown[],
    inner: (...args: unknown[]) => Promise<unknown>
  ): Promise<unknown> {
    const paths = (
      name === 'symlink' ? args.slice(1, 2) : PAIRED.has(name) ? args.slice(0, 2) : args.slice(0, 1)
    )
      .filter((path): path is string => typeof path === 'string')
      .map(normalizePath);
    const listing = LISTINGS.has(name);
    const removing = REMOVALS.has(name);
    const checked = [...paths];
    while (this.amongPeers()) {
      checked.length = 0;
      for (const at of paths) checked.push(...(await this.peerSettled(at, listing, removing)));
      if (!checked.some((at) => this.peerAt(at, listing, removing))) break;
    }
    const busy: Inflight = { paths: checked, removing, release: () => undefined };
    const done = () => {
      this.inflight.delete(busy);
      busy.waiting?.resolve();
    };
    busy.release = done;
    this.inflight.add(busy);
    if (name === 'rename') this.renameCall = busy;
    if (name !== 'writeSession') return await inner.apply(this, args).finally(done);
    const session = (await inner.apply(this, args).catch((err: unknown) => {
      done();
      throw err;
    })) as WriteSession;
    return { ...session, close: () => session.close().finally(done) };
  }

  private readonly renamingDirs = new Set<{ from: string; to: string; done: Promise<void> }>();

  private intents = 0;

  private async intend(
    rename: Omit<NonNullable<MetaEntry['rename']>, 'at'>,
    at = `${RENAMES}/${crypto.randomUUID()}`
  ): Promise<string> {
    const record = { ...rename, at: Date.now() * 1000 + (this.intents++ % 1000) };
    await this.meta.update(at, () => ({ path: at, rename: record }));
    return at;
  }

  private async rollBack(from: string, to: string, intents: Array<string | undefined>) {
    try {
      if (await this.real(from)) {
        const moved = await this.locate(from, false);
        const back = await this.locate(parentOf(to), true);
        await this.copy(
          moved.handle as Handle,
          back.handle as FileSystemDirectoryHandle,
          baseOf(to)
        );
        const [dir, name] = await this.parent(from);
        await this.inDir(dir, (parent) => parent.removeEntry(name, { recursive: true }));
      }
      this.forget(from);
      this.forget(to);
      for (const intent of intents) if (intent) await this.meta.update(intent, () => undefined);
    } catch {}
  }

  private replaying: Promise<unknown> = Promise.resolve();

  private orphans(): Promise<unknown> {
    this.replaying = this.replaying.then(() => this.finishRenames(true)).catch(() => 0);
    return this.replaying;
  }

  private async finishRenames(orphaned = false): Promise<number> {
    const locks = this.locks;
    const held = new Set<string | undefined>();
    if (orphaned && locks) {
      const { held: h = [], pending = [] } = await locks.query();
      for (const lock of [...h, ...pending]) held.add(lock.name);
    }
    const intents = (await this.meta.under(RENAMES))
      .filter(
        (entry) =>
          entry.rename !== undefined &&
          (!orphaned ||
            (locks !== undefined &&
              entry.rename.lock !== undefined &&
              !held.has(entry.rename.lock)))
      )
      .sort(
        (a, b) =>
          (a.rename as NonNullable<MetaEntry['rename']>).at -
          (b.rename as NonNullable<MetaEntry['rename']>).at
      );
    for (const entry of intents) {
      const lock = (entry.rename as NonNullable<MetaEntry['rename']>).lock;
      if (!locks || !lock) await this.finishRename(entry);
      else await locks.request(lock, () => this.finishRename(entry));
    }
    return intents.length;
  }

  private async finishRename(entry: MetaEntry): Promise<void> {
    const [current] = await this.meta.under(entry.path);
    if (current?.rename === undefined) return;
    const { from, to, replace, root } = current.rename;
    const { promise, resolve } = Promise.withResolvers<void>();
    const barrier = { from, to, done: promise };
    this.renamingDirs.add(barrier);
    this.forget(from);
    this.forget(to);
    try {
      const left = await this.real(from);
      if (left && replace && (await this.real(to)))
        await PLAIN.rm.call(this, to, { recursive: true });
      if (left) {
        const source = await this.locate(from, false);
        const target = await this.locate(parentOf(to), true);
        await this.copy(
          source.handle as Handle,
          target.handle as FileSystemDirectoryHandle,
          baseOf(to)
        );
        const [dir, name] = await this.parent(from);
        await this.inDir(dir, (parent) => parent.removeEntry(name, { recursive: true }));
        this.forget(from);
        this.forget(to);
      }
      if ((await this.meta.under(from)).some((entry) => !entry.vacated)) {
        await this.meta.move(
          from,
          to,
          (moved) => ({
            ...occupied(moved),
            ...root,
            ino: occupied(moved).ino ?? root?.ino ?? inodeOf(from),
            path: to,
          }),
          undefined
        );
      }
      await this.meta.update(entry.path, () => undefined);
      this.remote?.emit({ paths: [], trees: [], moved: { from, to } });
    } finally {
      this.renamingDirs.delete(barrier);
      resolve();
    }
  }

  async settledRename(path: unknown): Promise<void> {
    if ((this.renamingDirs.size === 0 && this.copying.size === 0) || typeof path !== 'string')
      return;
    const at = normalizePath(path);
    for (let real: string | undefined; ; ) {
      const busy = this.busyAt(at) ?? (real === undefined ? undefined : this.busyAt(real));
      if (busy) {
        await busy.done;
        continue;
      }
      if (real !== undefined || at === '/') return;
      const parent = await this.realpath(parentOf(at), true).catch(() => parentOf(at));
      real = resolvePath(parent, baseOf(at));
      if (real === at) return;
    }
  }

  private busyAt(at: string): { done: Promise<void> } | undefined {
    return this.renameAt(at) ?? this.copying.get(at);
  }

  private readonly copying = new Map<string, { done: Promise<void> }>();

  async copyFile(from: string, to: string, options: CopyOptions): Promise<void> {
    const source = await this.locate(from, true);
    if (source.handle?.kind !== 'file') throw fsError('EINVAL', `${from}: not a regular file`);
    const [entry] = await this.meta.get([source.path]);
    if (entry?.fifo || entry?.socket) throw fsError('EINVAL', `${from}: not a regular file`);
    const parent = await this.locate(parentOf(to), true);
    if (parent.handle?.kind !== 'directory') throw fsError('ENOTDIR', to);
    const destination = resolvePath(parent.path, baseOf(to));
    if (destination === source.path) throw fsError('EINVAL', `${from}: copied onto itself`);
    const file = await this.reading(source.path, (handle) => handle.getFile());
    const { promise, resolve } = Promise.withResolvers<void>();
    while (this.copying.has(destination)) await this.copying.get(destination)?.done;
    this.copying.set(destination, { done: promise });
    try {
      await this.copyInto(file, destination, to, options);
    } finally {
      this.copying.delete(destination);
      resolve();
    }
  }

  private async copyInto(file: File, destination: string, to: string, options: CopyOptions) {
    let created = false;
    if (options.exclusive) {
      await this.createExclusive(destination, options.owner);
      created = true;
    }
    let target = destination;
    let writable: FileSystemWritableFileStream | undefined;
    let handle: FileSystemFileHandle | undefined;
    try {
      const kept = created ? this.files.get(destination) : undefined;
      if (kept) {
        if (options.owner?.fifo || options.owner?.socket) throw fsError('ENXIO', to);
        handle = kept;
      } else {
        const [made, existed, at] = await this.fileFor(destination);
        handle = made;
        target = at;
        if (!existed && !created) {
          created = true;
          await this.stampNew(target, options.owner, false);
        }
        const [entry] = await this.meta.get([target]);
        if (entry?.fifo || entry?.socket) throw fsError('ENXIO', to);
      }
      this.wrote(handle);
      writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
    } catch (err) {
      await writable?.abort().catch(() => undefined);
      if (created) await this.rm(target, { file: true }).catch(() => undefined);
      throw translate(err, to, 'commit', false);
    } finally {
      if (handle) this.wrote(handle);
    }
    this.committed(target);
  }

  private renameAt(at: string): { done: Promise<void> } | undefined {
    for (const m of this.renamingDirs) {
      if (
        within(at, m.from) ||
        within(at, m.to) ||
        at === parentOf(m.from) ||
        at === parentOf(m.to)
      )
        return m;
    }
    return undefined;
  }

  private async replacingTarget<T>(replaces: boolean, op: () => Promise<T>): Promise<T> {
    if (!replaces) return op();
    const { promise, resolve } = Promise.withResolvers<void>();
    const before = this.replacing;
    this.replacing = Promise.all([before, promise]).then(() => undefined);
    this.replacements++;
    this.changes++;
    try {
      return await op();
    } finally {
      this.replacements++;
      this.changes++;
      resolve();
    }
  }

  private async modified(path: string): Promise<number> {
    const handle = await this.handle(path);
    return handle.kind === 'file' ? (await this.snapshot(handle)).lastModified : 0;
  }

  private async restamp(path: string, copies: Copies): Promise<void> {
    if (copies.size === 0) return;
    const copied = [...copies];
    const entries = await this.meta.get(copied.map(([rest]) => path + rest));
    for (const [i, [rest, { before, made }]] of copied.entries()) {
      if (entries[i]?.mtimeFor !== before) continue;
      const mtimeFor = (await this.io(made.getFile())).lastModified;
      await this.meta.update(path + rest, (entry) => entry && { ...entry, mtimeFor });
    }
  }

  private async place(
    handle: Handle,
    dir: FileSystemDirectoryHandle,
    name: string,
    copies?: Copies
  ) {
    const move = (handle as Handle & MovableHandle).move;
    if (move) this.others++;
    const moved = await move?.call(handle, dir, name).then(
      () => true,
      () => false
    );
    if (moved) return true;
    const before = this.fileMoves;
    try {
      await this.copy(handle, dir, name, copies);
    } catch (err) {
      if (handle.kind === 'directory' && this.fileMoves === before) {
        await this.io(dir.removeEntry(name, { recursive: true }));
      }
      throw translate(err, name);
    }
    return false;
  }

  private fileMoves = 0;

  private async copy(
    handle: Handle,
    dir: FileSystemDirectoryHandle,
    name: string,
    copies?: Copies,
    rest = ''
  ): Promise<void> {
    if (handle.kind === 'file' && movable(handle)) {
      this.others++;
      const moved = await (handle as Handle & MovableHandle).move?.(dir, name).then(
        () => true,
        () => false
      );
      if (moved) {
        this.fileMoves++;
        return;
      }
    }
    if (handle.kind === 'file') {
      const made = await this.io(dir.getFileHandle(name, { create: true }));
      const writable = await this.io(made.createWritable());
      const file = await this.io(handle.getFile());
      await writable.write(file);
      await writable.close();
      copies?.set(rest, { before: copies.get(rest)?.before ?? file.lastModified, made });
      return;
    }
    const target = await this.io(dir.getDirectoryHandle(name, { create: true }));
    this.others++;
    for await (const child of handle.values()) {
      await this.copy(child, target, child.name, copies, `${rest}/${child.name}`);
    }
  }

  async symlink(target: string, path: string, owner?: NewOwner): Promise<void> {
    const parent = await this.locate(parentOf(path), true);
    if (parent.handle?.kind !== 'directory') throw fsError('ENOTDIR', path);
    const at = resolvePath(parent.path, baseOf(path));
    this.refuse(at);
    if (
      await this.exactly(() => this.locate(at, false)).then(
        () => true,
        (err) => !missing(err)
      )
    ) {
      throw fsError('EEXIST', path);
    }
    const now = Date.now();
    const fields = await this.newFields(at, owner && { uid: owner.uid, gid: owner.gid }, false);
    await this.entering(at, () =>
      this.meta.update(at, (entry) => ({
        path: at,
        link: target,
        dir: parent.path,
        ino: entry?.vacated && entry.ino !== undefined ? entry.ino : inodeOf(at),
        mtimeMs: now,
        ctimeMs: now,
        ...fields,
      }))
    );
    this.touch(Date.now(), parent.path);
  }

  async realpath(path: string, follow: boolean): Promise<string> {
    return (await this.locate(path, follow)).path;
  }

  async readlink(path: string): Promise<string> {
    const found = await this.locate(path, false);
    if (found.link) return found.link.link as string;
    throw fsError('EINVAL', path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const found = await this.locate(path, true);
    this.refuse(found.path);
    const [known] = await this.meta.get([found.path]);
    const directory = found.handle?.kind === 'directory';
    if ((this.mode(found.path, directory, known) & PERM_MASK) === (mode & PERM_MASK)) return;
    const ctimeMs = Date.now();
    await this.meta.update(found.path, (entry) => ({
      ...entry,
      path: found.path,
      mode: mode & PERM_MASK,
      ctimeMs,
    }));
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await swapped(async () => this.setTimes(await this.locate(path, true), atime, mtime));
  }

  async lutimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await swapped(async () => this.setTimes(await this.locate(path, false), atime, mtime));
  }

  private async setTimes(found: Located, atime: Date, mtime: Date): Promise<void> {
    this.refuse(found.path);
    const { link } = found;
    if (link) {
      const ctimeMs = Date.now();
      await this.meta.update(found.path, (entry) => ({
        ...link,
        ...entry,
        atimeMs: atime.getTime(),
        mtimeMs: mtime.getTime(),
        ctimeMs,
      }));
      return;
    }
    const handle = found.handle as Handle;
    const file = handle.kind === 'file' ? await this.io(handle.getFile()) : undefined;
    this.dirTimes.delete(found.path);
    this.fileTimes.delete(found.path);
    const ctimeMs = Date.now();
    await this.meta.update(found.path, (entry) => ({
      ...entry,
      path: found.path,
      atimeMs: atime.getTime(),
      mtimeMs: mtime.getTime(),
      mtimeFor: file?.lastModified ?? 0,
      ctimeMs,
      timesAt: ctimeMs,
      timesBy: this.id,
    }));
  }

  private async present(paths: readonly string[]): Promise<(path: string) => Promise<boolean>> {
    type Listing = Map<string, FileSystemHandle> | undefined | null;
    const listed = new Map<string, Promise<Listing>>();
    const done = new Map<string, Listing>();
    const list = (dir: string): Promise<Listing> => {
      const known = listed.get(dir);
      if (known !== undefined) return known;
      const listing = (async (): Promise<Listing> => {
        const above = dir === '/' ? undefined : await list(parentOf(dir));
        if (above === null) return null;
        const handle = dir === '/' ? this.root : above?.get(baseOf(dir));
        if (handle?.kind !== 'directory') return undefined;
        this.calls++;
        const children = new Map<string, FileSystemHandle>();
        try {
          for await (const child of (handle as FileSystemDirectoryHandle).values())
            children.set(child.name, child);
        } catch {
          return null;
        }
        return children;
      })().then((children) => {
        done.set(dir, children);
        return children;
      });
      listed.set(dir, listing);
      return listing;
    };
    const dirs = [...new Set(paths.filter((p) => split(p).length > 0).map(parentOf))];
    let next = 0;
    const lister = async () => {
      while (next < dirs.length) await list(dirs[next++] as string);
    };
    await Promise.all(Array.from({ length: Math.min(RECONCILE_LISTINGS, dirs.length) }, lister));
    return async (path) => {
      if (split(path).length === 0) return true;
      const listing = done.get(parentOf(path));
      if (listing === null) return this.real(path);
      return listing?.has(baseOf(path)) === true;
    };
  }

  async reconcile(): Promise<number> {
    if (this.remote && (await this.remote.peered())) {
      await this.orphans();
      return 0;
    }
    await this.finishRenames();
    let removed = 0;
    const entries = await this.meta.all();
    const carried = new Set(entries.filter((e) => !e.vacated).map((e) => e.ino));
    const checked = entries.filter((e) => !(e.vacated && carried.has(inodeOf(e.path))));
    const real = await this.present(
      checked.flatMap((e) => (e.link === undefined ? [e.path] : [e.path, parentOf(e.path)]))
    );
    for (const entry of checked) {
      const stale =
        entry.link === undefined
          ? !(await real(entry.path))
          : (await real(entry.path)) || !(await real(parentOf(entry.path)));
      if (!stale) continue;
      const seen = JSON.stringify(entry);
      await this.meta.update(entry.path, (now) =>
        now === undefined || JSON.stringify(now) === seen ? undefined : now
      );
      removed++;
    }
    return removed;
  }
}

function movedOf(moved: unknown): { from: string; to: string } | undefined {
  const m = moved as { from?: unknown; to?: unknown } | undefined;
  return typeof m?.from === 'string' && typeof m.to === 'string'
    ? { from: m.from, to: m.to }
    : undefined;
}

function nothing(): undefined {
  return undefined;
}

function touches(
  at: string,
  trees: ReadonlyArray<readonly [string, string]>,
  listing = true,
  removing = false
): boolean {
  return trees.some(
    ([from, to]) =>
      within(at, from) ||
      within(at, to) ||
      (listing && (at === parentOf(from) || at === parentOf(to))) ||
      (removing && (at === '/' || within(from, at) || within(to, at)))
  );
}

function byIntent(a: MetaEntry, b: MetaEntry): number {
  return (
    (a.rename as NonNullable<MetaEntry['rename']>).at -
    (b.rename as NonNullable<MetaEntry['rename']>).at
  );
}

const PLAIN = {
  rm: OpfsFs.prototype.rm,
  realpath: OpfsFs.prototype.realpath,
};

const READS = [
  'stat',
  'lstat',
  'exists',
  'readFile',
  'readFileBuffer',
  'pread',
  'readdir',
  'readdirStat',
  'readlink',
  'realpath',
  'version',
  'readVersioned',
] as const;
const WRITES = [
  'copyFile',
  'writeFile',
  'pwrite',
  'truncate',
  'writeSession',
  'mkdir',
  'rm',
  'link',
  'rename',
  'symlink',
  'chmod',
  'utimes',
  'lutimes',
  'chown',
] as const;

{
  const proto = OpfsFs.prototype as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const inner = proto.createExclusive as (...args: unknown[]) => Promise<unknown>;
  proto.createExclusive = function (this: OpfsFs, ...args: unknown[]) {
    if (this.amongPeers()) return this.peerOp('createExclusive', args, inner);
    return this.alonePlain(inner, args);
  };
}

for (const [names, op] of [
  [READS, 'read'],
  [WRITES, 'write'],
] as const) {
  for (const name of names) {
    const proto = OpfsFs.prototype as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const inner = proto[name] as (...args: unknown[]) => Promise<unknown>;
    proto[name] = async function (this: OpfsFs, ...args: unknown[]) {
      try {
        if (op === 'read') await this.settledRename(args[0]);
        if (this.amongPeers() || name === 'writeSession')
          return await this.peerOp(name, args, inner);
        return await this.alonePlain(inner, args);
      } catch (err) {
        throw translate(err, String(args[0]), op, false);
      }
    };
  }
}
