import { META_DB, type MetaEntry, openMeta } from './fs/meta.ts';
import { fsError, normalizePath } from './fs/types.ts';

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
  const wanted = entries.map(checked);
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
