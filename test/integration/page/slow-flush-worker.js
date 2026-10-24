import '/dist/kernel-worker.js';

const params = new URL(import.meta.url).searchParams;
const delay = Number(params.get('ms') ?? 20000);
const name = params.get('name');
let armed = name === null;
let slow = false;
const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...args) {
  const now = name === null ? slow : armed && this.name === name;
  if (now) {
    slow = false;
    armed = false;
    const stamps = new BroadcastChannel('slow-flush');
    stamps.postMessage({ start: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, delay));
    stamps.postMessage({ end: Date.now() });
  }
  return open.apply(this, args);
};
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
