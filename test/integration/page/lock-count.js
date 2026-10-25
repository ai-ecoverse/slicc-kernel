const counts = new BroadcastChannel('lock-count');
let taken = 0;
const read = {};
const add = (name, n) => {
  if (name) read[name] = (read[name] ?? 0) + n;
};
const request = navigator.locks.request.bind(navigator.locks);
navigator.locks.request = (name, ...rest) => {
  if (String(name).startsWith('slicc-append:')) taken++;
  return request(name, ...rest);
};
const slice = Blob.prototype.slice;
Blob.prototype.slice = function (...args) {
  const part = slice.apply(this, args);
  part.counted = this.counted ?? this.name;
  return part;
};
const bytes = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = function (...args) {
  add(this.counted ?? this.name, this.size);
  return bytes.apply(this, args);
};
const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
if (open) {
  FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...args) {
    const handle = await open.apply(this, args);
    handle.counted = this.name;
    return handle;
  };
  const sync = FileSystemSyncAccessHandle.prototype.read;
  FileSystemSyncAccessHandle.prototype.read = function (...args) {
    const n = sync.apply(this, args);
    add(this.counted, n);
    return n;
  };
}
counts.onmessage = () => counts.postMessage({ taken, read });
