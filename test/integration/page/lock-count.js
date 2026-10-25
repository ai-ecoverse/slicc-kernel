const counts = new BroadcastChannel('lock-count');
let taken = 0;
let read = 0;
const request = navigator.locks.request.bind(navigator.locks);
navigator.locks.request = (name, ...rest) => {
  if (String(name).startsWith('slicc-append:')) taken++;
  return request(name, ...rest);
};
const bytes = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = function (...args) {
  read += this.size;
  return bytes.apply(this, args);
};
if (typeof FileSystemSyncAccessHandle !== 'undefined') {
  const sync = FileSystemSyncAccessHandle.prototype.read;
  FileSystemSyncAccessHandle.prototype.read = function (...args) {
    const n = sync.apply(this, args);
    read += n;
    return n;
  };
}
counts.onmessage = () => counts.postMessage({ taken, read });
