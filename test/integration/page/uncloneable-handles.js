const holdsHandle = (value, seen = new Set()) => {
  if (value instanceof FileSystemHandle) return true;
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  return Object.values(value).some((item) => holdsHandle(item, seen));
};

const refused = (proto, name) => {
  const native = proto[name];
  proto[name] = function (value, ...rest) {
    if (holdsHandle(value))
      throw new DOMException('The object can not be cloned.', 'DataCloneError');
    return native.call(this, value, ...rest);
  };
};

refused(MessagePort.prototype, 'postMessage');
refused(IDBObjectStore.prototype, 'put');
refused(IDBObjectStore.prototype, 'add');
if (globalThis.Worker) refused(Worker.prototype, 'postMessage');
if (globalThis.DedicatedWorkerGlobalScope) {
  refused(DedicatedWorkerGlobalScope.prototype, 'postMessage');
}
