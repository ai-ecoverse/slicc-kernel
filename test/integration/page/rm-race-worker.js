import '/dist/kernel-worker.js';

let target = new URL(import.meta.url).searchParams.get('race');
const remove = IDBObjectStore.prototype.delete;
IDBObjectStore.prototype.delete = function (key) {
  const request = remove.call(this, key);
  if (key === target && this.transaction.mode === 'readwrite') {
    target = undefined;
    const { db } = this.transaction;
    const name = this.name;
    this.transaction.addEventListener('complete', () => {
      const store = db.transaction(name, 'readwrite').objectStore(name);
      const current = store.get(key);
      current.onsuccess = () => {
        const { vacated: _, ...kept } = current.result ?? {};
        store.put({ ...kept, path: key });
      };
    });
  }
  return request;
};
