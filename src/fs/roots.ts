import { META_DB } from './meta.ts';

const ROOTS_DB = 'slicc-kernel-roots';
const ROOTS_STORE = 'roots';

interface RootRecord {
  id: string;
  handle: FileSystemDirectoryHandle;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const req = factory.open(ROOTS_DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(ROOTS_STORE, { keyPath: 'id' });
  return request(req);
}

async function same(a: FileSystemHandle, b: FileSystemHandle): Promise<boolean> {
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}

export async function rootId(
  factory: IDBFactory,
  root: FileSystemDirectoryHandle,
  locks: LockManager | undefined = globalThis.navigator?.locks
): Promise<string> {
  const find = async () => {
    const db = await open(factory);
    try {
      const all = (await request(
        db.transaction(ROOTS_STORE, 'readonly').objectStore(ROOTS_STORE).getAll()
      )) as RootRecord[];
      for (const record of all) if (await same(record.handle, root)) return record.id;
      const id = crypto.randomUUID();
      const tx = db.transaction(ROOTS_STORE, 'readwrite');
      tx.objectStore(ROOTS_STORE).put({ id, handle: root });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return id;
    } finally {
      db.close();
    }
  };
  return locks ? locks.request(ROOTS_DB, find) : find();
}

export async function metadataName(
  top: FileSystemDirectoryHandle | undefined,
  root: FileSystemDirectoryHandle,
  id: (root: FileSystemDirectoryHandle) => Promise<string>
): Promise<string> {
  if (!top || (await same(top, root))) return META_DB;
  return `${META_DB}:${await id(root)}`;
}
