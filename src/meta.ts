import { META_DB, type MetaEntry, openMeta } from './fs/meta.ts';
import { dirsChannel, type FsNotice } from './fs/notice.ts';
import { fsError, normalizePath } from './fs/types.ts';
import {
  exclusively,
  REPLACED_WAIT_MS,
  replacingLock,
  replacingLocks,
} from './kernel/replacing.ts';

export type { FsNotice };

export interface MetadataEntry {
  path: string;
  mode?: number;
  uid?: number;
  gid?: number;
}

export interface WriteMetadataOptions {
  metadata?: string;
  indexedDB?: IDBFactory;
}

const MAX_ID = 0xfffffffe;

function id(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_ID) {
    throw fsError('EINVAL', `not a ${what}: ${String(value)}`);
  }
  return value as number;
}

function checked(entry: MetadataEntry): MetadataEntry {
  if (!String(entry.path).startsWith('/'))
    throw fsError('EINVAL', `not an absolute path: ${entry.path}`);
  const path = normalizePath(String(entry.path));
  if ((entry.uid === undefined) !== (entry.gid === undefined)) {
    throw fsError('EINVAL', `${path}: give both uid and gid, or neither`);
  }
  const mode = entry.mode;
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)) {
    throw fsError('EINVAL', `${path}: not a mode: ${String(mode)}`);
  }
  return {
    path,
    ...(mode !== undefined ? { mode } : {}),
    ...(entry.uid !== undefined ? { uid: id(entry.uid, 'uid'), gid: id(entry.gid, 'gid') } : {}),
  };
}

async function present(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  const parts = path.split('/').filter(Boolean);
  let dir = root;
  for (const [i, name] of parts.entries()) {
    const last = i === parts.length - 1;
    try {
      dir = await dir.getDirectoryHandle(name);
    } catch {
      if (!last) return false;
      return dir.getFileHandle(name).then(
        () => true,
        () => false
      );
    }
  }
  return true;
}

export async function writeMetadata(
  root: FileSystemDirectoryHandle,
  entries: readonly MetadataEntry[],
  options: WriteMetadataOptions = {}
): Promise<void> {
  const merged = new Map<string, MetadataEntry>();
  for (const want of entries.map(checked))
    merged.set(want.path, { ...merged.get(want.path), ...want });
  const wanted = [...merged.values()];
  for (const { path } of wanted) {
    if (!(await present(root, path))) throw fsError('ENOENT', path);
  }
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const store = await openMeta(options.metadata ?? META_DB, factory);
  const ctimeMs = Date.now();
  try {
    await store.updateMany(
      wanted.map((want) => ({
        path: want.path,
        change: (entry: MetaEntry | undefined): MetaEntry => ({
          ...entry,
          path: want.path,
          ...(want.mode !== undefined ? { mode: want.mode } : {}),
          ...(want.uid !== undefined ? { uid: want.uid, gid: want.gid as number } : {}),
          ctimeMs,
        }),
      }))
    );
  } finally {
    store.close();
  }
}

export interface PostFsNoticeOptions {
  metadata?: string;
}

function absolute(list: readonly string[] | undefined): string[] {
  return (list ?? []).map((path) => {
    if (!String(path).startsWith('/')) throw fsError('EINVAL', `not an absolute path: ${path}`);
    return normalizePath(String(path));
  });
}

export function postFsNotice(notice: FsNotice, options: PostFsNoticeOptions = {}): void {
  const paths = absolute(notice.paths);
  const trees = absolute(notice.trees);
  if (paths.length === 0 && trees.length === 0) return;
  const channel = new BroadcastChannel(dirsChannel(options.metadata ?? META_DB));
  try {
    channel.postMessage({ paths, trees });
  } finally {
    channel.close();
  }
}

export interface ReplacingOptions {
  metadata?: string;
}

const HELD = Symbol.for('slicc-kernel.replacing.v1');

function realmHeld(): Set<string> {
  const scope = globalThis as { [HELD]?: Set<string> };
  scope[HELD] ??= new Set();
  return scope[HELD];
}

export async function replacing<T>(
  paths: readonly string[],
  task: () => T | Promise<T>,
  options: ReplacingOptions = {}
): Promise<T> {
  if (!Array.isArray(paths)) throw new TypeError('replacing: paths must be an array of paths');
  if (typeof task !== 'function') throw new TypeError('replacing: task must be a function');
  const roots = [...new Set(absolute(paths))].sort();
  const metadata = options.metadata ?? META_DB;
  const held = realmHeld();
  const busy = roots.find((root) => held.has(root));
  if (busy !== undefined) {
    throw fsError('EDEADLK', `${busy} is already being replaced in this realm`);
  }
  const locks = replacingLocks();
  const run = async () => {
    try {
      return await task();
    } finally {
      postFsNotice({ trees: roots }, { metadata });
      if (locks && roots.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, REPLACED_WAIT_MS));
      }
    }
  };
  for (const root of roots) held.add(root);
  try {
    if (!locks) return await run();
    const names = roots.map((root) => replacingLock(metadata, root));
    return await exclusively(locks, names, run);
  } finally {
    for (const root of roots) held.delete(root);
  }
}
