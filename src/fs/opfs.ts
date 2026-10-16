import { MemoryMeta, type MetaEntry, type MetaStore, type MetaUpdate } from './meta.ts';
import { chain, inherit, ownOf, ROOT_OWNER, sameOwner } from './owners.ts';
import { PathMap } from './path-map.ts';
import { holdsProtected, isProtected } from './protect.ts';
import {
  type LockManagerLike,
  lockManager,
  type RemoteChange,
  type RemoteListener,
  RemoteWatch,
} from './remote.ts';
import {
  type FsStat,
  fsError,
  inodeOf,
  type KernelFs,
  type NewOwner,
  normalizePath,
  type Owner,
  type OwnerChange,
  type Perm,
  redirected,
  resolvePath,
} from './types.ts';
import { view } from './view.ts';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;
const PERM_MASK = 0o7777;
const S_ISGID = 0o2000;
const READ_ATTEMPTS = 3;
const MAX_LINKS = 40;
const CHECK_MS = 1000;
const FILE_HANDLES = 4096;
const STALE: ReadonlySet<string> = new Set(['NotFoundError', 'TypeMismatchError']);
const EXECUTABLE = /\/node_modules\/(?:@[^/]+\/)?[^/]+\/bin\//;

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface MovableHandle {
  move?(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
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
  const { removeFile } = meta;
  if (removeFile)
    ops.removeFile = (path: string) =>
      removeFile.call(meta, path).catch((err: unknown) => {
        throw translate(err, path, 'sidecar', false);
      });
  return ops;
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
  const access = await openSync(handle);
  if (access) {
    try {
      op({
        write: (at, bytes) => writeAll(access, at, bytes),
        truncate: (n) => access.truncate(n),
      });
      access.flush();
    } finally {
      access.close();
    }
    return;
  }
  const writable = await handle.createWritable({ keepExistingData: true });
  try {
    await op({
      write: (at, bytes) =>
        writable.write({ type: 'write', position: at, data: bytes as Uint8Array<ArrayBuffer> }),
      truncate: (n) => writable.truncate(n),
    });
  } catch (err) {
    await writable.abort();
    throw err;
  }
  await writable.close();
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
  private readonly snapshots = new WeakMap<FileSystemFileHandle, File>();
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
    this.channel = channel === undefined ? undefined : new BroadcastChannel(channel);
    this.remote = channel === undefined ? undefined : new RemoteWatch(`${channel}:watch`);
    if (this.channel) {
      const remote = this.remote;
      (meta as { listen?: (l: (c: Partial<RemoteChange>) => void) => void }).listen?.((c) =>
        remote?.emit({ paths: c.paths ?? [], trees: c.trees ?? [] })
      );
      this.channel.onmessage = ({ data }) => {
        for (const path of data as string[]) this.forget(path);
        remote?.emit({ paths: data as string[], trees: [] });
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
    if (this.remote?.watched()) this.remote.wrote(target);
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
    const where = await this.root.resolve(handle).catch(() => null);
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
    const fields = owner?.socket && !directory ? { ...owned, socket: true as const } : owned;
    if (fields) await this.meta.update(path, (entry) => ({ ...entry, path, ...fields }));
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

  private async locked<T>(physicalPath: string, op: () => Promise<T>): Promise<T> {
    if (!this.locks) return op();
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
    const where = await this.root.resolve(dir).catch(() => null);
    if (where === null || `/${where.join('/')}` !== path) return false;
    this.checked.set(dir, performance.now());
    return true;
  }

  private forget(path: string): void {
    this.dirs.deleteTree(path);
    this.files.deleteTree(path);
  }

  private remember(path: string, handle: Handle, looked = false): Handle {
    if (handle.kind !== 'file') return handle;
    if (looked) {
      this.found.set(handle as FileSystemFileHandle, performance.now());
      this.snapshots.delete(handle as FileSystemFileHandle);
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
      try {
        this.snapshots.set(cached, await cached.getFile());
        return this.remember(path, cached);
      } catch (err) {
        if (!STALE.has((err as { name?: string })?.name as string))
          throw translate(err, path, 'read');
        this.files.delete(path);
        this.snapshots.delete(cached);
      }
    }
    const [dir, name] = await this.parent(path);
    const known = this.dirs.has(path);
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
      throw translate(err, path);
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
      if (!(await this.real(entry.path)) && (await this.real(parentOf(entry.path)))) return entry;
    }
    return undefined;
  }

  private async locate(path: string, follow: boolean): Promise<Located> {
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
    const type = directory ? S_IFDIR : meta?.socket ? S_IFSOCK : S_IFREG;
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
    for (const dir of dirs) {
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

  private async snapshot(handle: FileSystemFileHandle): Promise<File> {
    const taken = this.snapshots.get(handle);
    if (!taken) return handle.getFile();
    this.snapshots.delete(handle);
    return taken;
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
    return {
      isFile: !directory && !socket,
      isDirectory: directory,
      isSymbolicLink: false,
      ...(socket ? { isSocket: true } : {}),
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

  async stat(path: string): Promise<FsStat> {
    return this.describe(await this.locate(path, true));
  }

  async lstat(path: string): Promise<FsStat> {
    return this.describe(await this.locate(path, false));
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

  private async existing(path: string, writing = false): Promise<FileSystemFileHandle> {
    const found = await this.locate(path, true);
    if (writing) this.refuse(found.path);
    const handle = found.handle as Handle;
    if (handle.kind === 'directory') throw fsError('EISDIR', path);
    return handle;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const handle = await this.existing(path);
    return this.retrying(
      path,
      async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()),
      false
    );
  }

  async readVersioned(
    path: string,
    cached = false
  ): Promise<{ bytes: Uint8Array; version: string }> {
    const handle = await this.existing(path);
    return this.retrying(
      path,
      async () => {
        const stamp = await this.stamp(path, cached);
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        return { bytes, version: `${file.lastModified}:${file.size}:${stamp}` };
      },
      false
    );
  }

  async version(path: string, cached = false): Promise<string> {
    const handle = await this.existing(path);
    return this.retrying(
      path,
      async () => {
        const stamp = await this.stamp(path, cached);
        const file = await handle.getFile();
        return `${file.lastModified}:${file.size}:${stamp}`;
      },
      false
    );
  }

  async pread(path: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await this.existing(path);
    return this.retrying(
      path,
      async () =>
        new Uint8Array(await (await handle.getFile()).slice(offset, offset + length).arrayBuffer()),
      false
    );
  }

  async pwrite(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    const [handle, , target] = await this.fileFor(path);
    await this.counting(target);
    try {
      await this.retrying(path, () => positioned(handle, (io) => io.write(offset, bytes)), true);
    } finally {
      await this.recounting(handle, target);
    }
    this.written(target);
  }

  async truncate(path: string, size: number): Promise<void> {
    const handle = await this.existing(path, true);
    const resolve = this.ranged || this.remote?.watched();
    const target = resolve || this.counted.length > 0 ? (await this.locate(path, true)).path : path;
    await this.counting(target);
    try {
      await this.retrying(path, () => positioned(handle, (io) => io.truncate(size)), true);
    } finally {
      await this.recounting(handle, target);
    }
    this.written(target);
  }

  async writeSession(path: string, truncate: boolean): Promise<WriteSession> {
    const [handle, , target] = await this.fileFor(path);
    const writable = await this.retrying(
      path,
      () => handle.createWritable({ keepExistingData: !truncate }),
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
        await writable.close().catch((err: unknown) => {
          throw translate(err, path, 'commit', false);
        });
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

  private async fileFor(path: string): Promise<[FileSystemFileHandle, boolean, string]> {
    const [target, existed] = await this.writeTarget(path);
    const [dir, name] = await this.parent(target);
    try {
      const handle = await this.inDir(dir, (parent) =>
        parent.getFileHandle(name, { create: true })
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
    try {
      writable = await file.createWritable();
      await writable.write(content as FileSystemWriteChunkType);
      await writable.close();
    } catch (err) {
      await writable?.abort().catch(() => undefined);
      throw translate(err, path, 'commit', false);
    }
    this.committed(target);
  }

  private async listing(path: string): Promise<[string, Array<[string, Handle | MetaEntry]>]> {
    const found = await this.locate(path, true);
    const handle = found.handle as Handle;
    if (handle.kind !== 'directory') throw fsError('ENOTDIR', path);
    const children = new Map<string, Handle | MetaEntry>();
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
      found = await this.locate(path, true);
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
    await parent.handle.getDirectoryHandle(baseOf(path), { create: true });
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
      if (freshMeta[0]?.link !== undefined) throw fsError('EEXIST', path);
      this.forget(physical);
      this.refuse(physical);
      await dir.getDirectoryHandle(name, { create: true });
      const now = Date.now();
      const made = `${parent.path === '/' ? '' : parent.path}/${name}`;
      await this.stampNew(made, owner, true);
      this.touch(now, parent.path, made);
    });
  }

  async createExclusive(path: string, owner?: NewOwner): Promise<void> {
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
      if (freshMeta[0] !== undefined) throw fsError('EEXIST', path);
      this.forget(physical);
      this.refuse(physical);
      await dir.getFileHandle(name, { create: true });
      const now = Date.now();
      const made = `${parent.path === '/' ? '' : parent.path}/${name}`;
      await this.stampNew(made, owner, false);
      this.touch(now, parent.path, made);
    });
  }

  private async handleExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
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
          parent.removeEntry(name, { recursive: options.recursive === true })
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
    await this.meta.remove([found.path]);
    this.touch(Date.now(), parentOf(found.path));
  }

  links(): boolean {
    return false;
  }

  async link(from: string, to: string, follow?: boolean): Promise<void> {
    await (follow ? this.stat(from) : this.lstat(from));
    if (!(await this.stat(parentOf(to))).isDirectory) throw fsError('ENOTDIR', to);
    const taken = await this.lstat(to).then(
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
    if (from === to) return;
    const source = await this.locate(from, false);
    this.refuse(source.path, true);
    this.forget(source.path);
    const parent = await this.locate(parentOf(to), true);
    const destination = resolvePath(parent.path, baseOf(to));
    this.refuse(destination, true);
    await this.entering(destination, () => this.moveTo(source, parent, destination, to));
  }

  private async moveTo(source: Located, parent: Located, destination: string, to: string) {
    const sourceStat = await this.describe(source);
    if (sourceStat.isDirectory && within(destination, source.path)) throw fsError('EINVAL', to);
    const target = await this.locate(destination, false).catch((err) => {
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
      ...entry,
      ...moving,
      path: destination,
      ctimeMs: now,
    });
    if (source.link) {
      if (target?.handle) await this.rm(destination);
      await this.meta.move(source.path, destination, carry);
      this.touch(Date.now(), parentOf(source.path), parent.path);
      return;
    }
    const dir = parent.handle as FileSystemDirectoryHandle;
    const name = baseOf(destination);
    const swap = targetStat?.isDirectory === true;
    const staging = swap ? `.${name}.${crypto.randomUUID()}` : name;
    this.forget(destination);
    const timed = await this.explicitTimes(source.path);
    const moved = await this.place(source.handle as Handle, dir, staging);
    if (swap) await this.rm(destination, { recursive: true });
    await this.meta.move(source.path, destination, carry);
    this.movePending(source.path, destination);
    if (!moved) await this.rm(source.path, { recursive: true });
    let copied = !moved;
    if (swap) {
      const staged = await dir.getDirectoryHandle(staging);
      const placed = await this.place(staged, dir, name);
      if (!placed) await dir.removeEntry(staging, { recursive: true });
      copied ||= !placed;
    }
    if (copied) await this.restamp(destination, timed);
    this.changed(source.path, destination);
    this.touch(Date.now(), parentOf(source.path), parent.path);
  }

  private async modified(path: string): Promise<number> {
    const handle = await this.handle(path);
    return handle.kind === 'file' ? (await handle.getFile()).lastModified : 0;
  }

  private async explicitTimes(path: string): Promise<string[]> {
    const timed: string[] = [];
    for (const entry of await this.meta.under(path)) {
      if (entry.mtimeFor === undefined || entry.link !== undefined) continue;
      const current = await this.modified(entry.path).catch(() => undefined);
      if (current === entry.mtimeFor) timed.push(entry.path.slice(path.length));
    }
    return timed;
  }

  private async restamp(path: string, timed: string[]): Promise<void> {
    for (const rest of timed) {
      const mtimeFor = await this.modified(path + rest);
      await this.meta.update(path + rest, (entry) => entry && { ...entry, mtimeFor });
    }
  }

  private async place(handle: Handle, dir: FileSystemDirectoryHandle, name: string) {
    const moved = await (handle as Handle & MovableHandle).move?.(dir, name).then(
      () => true,
      () => false
    );
    if (moved) return true;
    try {
      await this.copy(handle, dir, name);
    } catch (err) {
      if (handle.kind === 'directory') await dir.removeEntry(name, { recursive: true });
      throw translate(err, name);
    }
    return false;
  }

  private async copy(handle: Handle, dir: FileSystemDirectoryHandle, name: string): Promise<void> {
    if (handle.kind === 'file') {
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(await handle.getFile());
      await writable.close();
      return;
    }
    const target = await dir.getDirectoryHandle(name, { create: true });
    for await (const child of handle.values()) await this.copy(child, target, child.name);
  }

  async symlink(target: string, path: string, owner?: NewOwner): Promise<void> {
    const parent = await this.locate(parentOf(path), true);
    if (parent.handle?.kind !== 'directory') throw fsError('ENOTDIR', path);
    const at = resolvePath(parent.path, baseOf(path));
    this.refuse(at);
    if (
      await this.locate(at, false).then(
        () => true,
        (err) => !missing(err)
      )
    ) {
      throw fsError('EEXIST', path);
    }
    const now = Date.now();
    const fields = await this.newFields(at, owner && { uid: owner.uid, gid: owner.gid }, false);
    await this.entering(at, () =>
      this.meta.update(at, () => ({
        path: at,
        link: target,
        dir: parent.path,
        ino: inodeOf(at),
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
    const ctimeMs = Date.now();
    await this.meta.update(found.path, (entry) => ({
      ...entry,
      path: found.path,
      mode: mode & PERM_MASK,
      ctimeMs,
    }));
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await this.setTimes(await this.locate(path, true), atime, mtime);
  }

  async lutimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await this.setTimes(await this.locate(path, false), atime, mtime);
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
    const file = handle.kind === 'file' ? await handle.getFile() : undefined;
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

  async reconcile(): Promise<number> {
    let removed = 0;
    for (const entry of await this.meta.all()) {
      const real = await this.real(entry.path);
      const stale =
        entry.link === undefined ? !real : real || !(await this.real(parentOf(entry.path)));
      if (!stale) continue;
      await this.meta.update(entry.path, () => undefined);
      removed++;
    }
    return removed;
  }
}

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
] as const;
const WRITES = [
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
        return await inner.apply(this, args);
      } catch (err) {
        throw translate(err, String(args[0]), op, false);
      }
    };
  }
}
