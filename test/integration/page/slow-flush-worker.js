import '/dist/kernel-worker.js';

const delay = Number(new URL(import.meta.url).searchParams.get('ms') ?? 6000);
let slow = false;
const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...args) {
  if (slow) {
    slow = false;
    const stamps = new BroadcastChannel('slow-flush');
    stamps.postMessage({ start: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, delay));
    stamps.postMessage({ end: Date.now() });
    stamps.close();
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
