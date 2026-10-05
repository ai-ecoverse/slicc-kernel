function ask(worker, message) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage(message);
  });
}

window.probe = async () => {
  const worker = new Worker(new URL('./probe-worker.js', import.meta.url), { type: 'module' });
  const report = await ask(worker, { depth: 1 });
  worker.terminate();
  return { isolated: crossOriginIsolated, workers: report };
};
