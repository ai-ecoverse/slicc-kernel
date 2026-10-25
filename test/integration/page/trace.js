const at = () => `${(performance.now() / 1000).toFixed(3)}s`;
const frames = () =>
  (new Error().stack ?? '')
    .split('\n')
    .slice(2, 9)
    .map((l) =>
      l
        .trim()
        .replace(/^at /, '')
        .replace(/\(?https?:\/\/[^/]+\/dist\//, '')
        .replace(/\)$/, '')
    )
    .join(' < ');
const shown = (data) => {
  try {
    return JSON.stringify(data).slice(0, 240);
  } catch {
    return String(data);
  }
};
const handler = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage');
Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
  ...handler,
  set(listener) {
    const name = this.name;
    handler.set.call(this, (event) => {
      const text = shown(event.data);
      if (text.includes('/root/ap')) console.warn(`trace ${at()} heard on ${name}: ${text}`);
      return listener.call(this, event);
    });
  },
});
const getFile = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile = function (...args) {
  if (this.name === 'log') console.warn(`trace ${at()} getFile log: ${frames()}`);
  return getFile.apply(this, args);
};
const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
if (open) {
  FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...args) {
    const handle = await open.apply(this, args);
    if (this.name === 'log') {
      console.warn(`trace ${at()} sync handle log: ${frames()}`);
      const size = handle.getSize.bind(handle);
      handle.getSize = () => {
        const n = size();
        console.warn(`trace ${at()} getSize log = ${n}: ${frames()}`);
        return n;
      };
      const write = handle.write.bind(handle);
      handle.write = (buf, opts) => {
        console.warn(`trace ${at()} write log ${buf.byteLength} at ${opts?.at}`);
        return write(buf, opts);
      };
    }
    return handle;
  };
}
