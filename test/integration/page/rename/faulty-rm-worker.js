import '/dist/kernel-worker.js';

const params = new URL(import.meta.url).searchParams;
const stuck = params.get('stuck');
const occupy = params.get('occupy');
const move = FileSystemFileHandle.prototype.move;
FileSystemFileHandle.prototype.move = async function (...args) {
  if (this.name === stuck) {
    if (occupy) {
      const top = await navigator.storage.getDirectory();
      let dir = top;
      for (const part of occupy.split('/').slice(1, -1)) dir = await dir.getDirectoryHandle(part);
      const file = await dir.getFileHandle(occupy.split('/').at(-1), { create: true });
      const out = await file.createWritable();
      await out.write('NEW');
      await out.close();
    }
    throw new DOMException('injected', 'NoModificationAllowedError');
  }
  return move.apply(this, args);
};
