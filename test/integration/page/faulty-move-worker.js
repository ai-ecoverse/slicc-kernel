import '/dist/kernel-worker.js';

let attempts = Number(new URL(import.meta.url).searchParams.get('fail') ?? 0);
const UNLINKED = '.slicc-unlinked';
const refuse = () => Promise.reject(new DOMException('injected', 'NoModificationAllowedError'));
const move = FileSystemFileHandle.prototype.move;
FileSystemFileHandle.prototype.move = function (dir, ...rest) {
  if (dir?.name === UNLINKED && attempts > 0) return refuse();
  return move.call(this, dir, ...rest);
};
const getFileHandle = FileSystemDirectoryHandle.prototype.getFileHandle;
FileSystemDirectoryHandle.prototype.getFileHandle = function (name, options) {
  if (options?.create && this.name === UNLINKED && attempts > 0) {
    attempts--;
    return refuse();
  }
  return getFileHandle.call(this, name, options);
};
