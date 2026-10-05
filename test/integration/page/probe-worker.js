function waits() {
  const sab = new SharedArrayBuffer(4);
  return Atomics.wait(new Int32Array(sab), 0, 0, 1);
}

self.onmessage = async ({ data: { depth } }) => {
  const own = { isolated: crossOriginIsolated, wait: waits() };
  if (depth > 1) return self.postMessage([own]);
  const nested = new Worker(new URL('./probe-worker.js', import.meta.url), { type: 'module' });
  const deeper = await new Promise((resolve) => {
    nested.onmessage = ({ data }) => resolve(data);
    nested.postMessage({ depth: depth + 1 });
  });
  nested.terminate();
  self.postMessage([own, ...deeper]);
};
