import '/dist/kernel-worker.js';

const params = new URL(import.meta.url).searchParams;
const stuck = params.get('stuck');
const unremovable = params.get('unremovable');
const first = params.get('first');
const seen = params.get('seen');
const occupy = params.get('occupy');

const place = async (path, text) => {
  const top = await navigator.storage.getDirectory();
  let dir = top;
  for (const part of path.split('/').slice(1, -1)) dir = await dir.getDirectoryHandle(part);
  const file = await dir.getFileHandle(path.split('/').at(-1), { create: true });
  const out = await file.createWritable();
  await out.write(text);
  await out.close();
};

const aside = async () => {
  const top = await navigator.storage.getDirectory();
  const dir = await top.getDirectoryHandle('.slicc-unlinked').catch(() => undefined);
  const names = [];
  if (dir) for await (const name of dir.keys()) names.push(name);
  return names;
};

const move = FileSystemFileHandle.prototype.move;
FileSystemFileHandle.prototype.move = async function (...args) {
  if (this.name === stuck) {
    if (occupy) await place(occupy, 'NEW');
    throw new DOMException('injected', 'NoModificationAllowedError');
  }
  return move.apply(this, args);
};

const removeEntry = FileSystemDirectoryHandle.prototype.removeEntry;
let partway = false;
FileSystemDirectoryHandle.prototype.removeEntry = async function (name, ...rest) {
  if (name === unremovable && rest[0]?.recursive) {
    if (!partway) {
      partway = true;
      if (seen) await place(seen, JSON.stringify(await aside()));
      if (first) await (await this.getDirectoryHandle(name)).removeEntry(first);
      if (occupy) await place(occupy, 'NEW');
    }
    throw new DOMException('injected', 'NoModificationAllowedError');
  }
  return removeEntry.call(this, name, ...rest);
};
