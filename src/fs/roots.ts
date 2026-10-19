import { META_DB, META_STORE, openMetaDb } from './meta.ts';

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

export const nameOf = (id: string): string => `${META_DB}:${id}`;

function done(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function used(root: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const _ of root.keys()) return true;
  return false;
}

async function seed(factory: IDBFactory, name: string): Promise<void> {
  const known = await factory.databases?.().catch(() => undefined);
  if (known && !known.some((db) => db.name === META_DB)) return;
  const from = await openMetaDb(META_DB, factory);
  const to = await openMetaDb(name, factory);
  try {
    const rows = await request(
      from.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll()
    );
    const tx = to.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    for (const row of rows) store.put(row);
    await done(tx);
    console.warn(
      `slicc-kernel: a root not seen before got its own metadata database ${name}, a copy of ${rows.length} records of ${META_DB} (#1120)`
    );
  } finally {
    from.close();
    to.close();
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
      if (await used(root)) await seed(factory, nameOf(id));
      const tx = db.transaction(ROOTS_STORE, 'readwrite');
      tx.objectStore(ROOTS_STORE).put({ id, handle: root });
      await done(tx);
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
  return nameOf(await id(root));
}
