import '/dist/kernel-worker.js';

const params = new URL(import.meta.url).searchParams;
const delay = Number(params.get('ms') ?? 20000);
const name = params.get('name');
let armed = name !== null;
let slow = false;
const stamps = new BroadcastChannel('slow-flush');
const due = (handle, via) => {
  const now = name === null ? slow : armed && handle.name === name;
  if (!now) return undefined;
  slow = false;
  armed = false;
  stamps.postMessage({ start: Date.now(), via });
  return new Promise((resolve) => setTimeout(resolve, delay)).then(() => {
    stamps.postMessage({ end: Date.now(), via });
  });
};
for (const via of ['createSyncAccessHandle', 'createWritable']) {
  const original = FileSystemFileHandle.prototype[via];
  FileSystemFileHandle.prototype[via] = async function (...args) {
    await due(this, via);
    return original.apply(this, args);
  };
}
const handler = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage');
Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
  ...handler,
  set(listener) {
    handler.set.call(this, (event) => {
      if (this.name.endsWith(':watch') && event.data?.hello !== undefined) slow = true;
      return listener.call(this, event);
    });
  },
});
