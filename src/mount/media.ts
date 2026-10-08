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

export function openMedia(name: string, factory: IDBFactory): Promise<MediaStore> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(MEDIA_STORE);
  return settle(request, () => {
    const db = request.result;
    const store = (mode: IDBTransactionMode) =>
      db.transaction(MEDIA_STORE, mode).objectStore(MEDIA_STORE);
    return {
      get: (id) => {
        const got = store('readonly').get(id);
        return settle(got, () => got.result as MediumHandle | undefined);
      },
      put: (id, handle) => settle(store('readwrite').put(handle, id), () => undefined),
    } satisfies MediaStore;
  });
}
