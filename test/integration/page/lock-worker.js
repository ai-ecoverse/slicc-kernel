self.onmessage = async ({ data }) => {
  let dir = await navigator.storage.getDirectory();
  const parts = data.path.split('/').filter(Boolean);
  const name = parts.pop();
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  const handle = await (await dir.getFileHandle(name)).createSyncAccessHandle({
    mode: 'readwrite-unsafe',
  });
  self.postMessage('locked');
  setTimeout(() => {
    handle.close();
    self.postMessage('unlocked');
  }, data.ms);
};
