import { directoryAt, portable } from '../fs/portable.ts';
import type { MediumHandle } from './fsa.ts';

export interface MediaStore {
  get(id: string): Promise<MediumHandle | undefined>;
  put(id: string, handle: MediumHandle): Promise<void>;
}

export const MEDIA_STORE = 'handles';

export function memoryMedia(): MediaStore {
  const handles = new Map<string, MediumHandle>();
  return {
    get: async (id) => handles.get(id),
    put: async (id, handle) => void handles.set(id, handle),
  };
}

function settle<T>(request: IDBRequest, value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(value());
    request.onerror = () => reject(request.error);
  });
}

type Top = () => Promise<FileSystemDirectoryHandle>;

const privateTop: Top = () => navigator.storage.getDirectory();

async function stored(kept: unknown, top: Top): Promise<MediumHandle | undefined> {
  const path = (kept as { path?: unknown } | undefined)?.path;
  if (!Array.isArray(path)) return kept as MediumHandle | undefined;
  return directoryAt(await top(), path).catch(() => undefined);
}

export function openMedia(
  name: string,
  factory: IDBFactory,
  top: Top = privateTop
): Promise<MediaStore> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(MEDIA_STORE);
  return settle(request, () => {
    const db = request.result;
    const store = (mode: IDBTransactionMode) =>
      db.transaction(MEDIA_STORE, mode).objectStore(MEDIA_STORE);
    return {
      get: async (id) => {
        const got = store('readonly').get(id);
        return stored(await settle(got, () => got.result), top);
      },
      put: async (id, handle) => {
        const at = await portable(handle, top);
        const kept = 'path' in at ? at : handle;
        await settle(store('readwrite').put(kept, id), () => undefined);
      },
    } satisfies MediaStore;
  });
}
