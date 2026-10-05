import {
  checkLocalProxy,
  createKernel,
  fetchTransport,
  localProxyTransport,
  probeLocalProxy,
} from '/dist/index.js';

const packages = {
  'node_modules/socktest/': ['package.json', 'bin/socktest', 'bin/socktest.wasm'],
  'node_modules/@ai-ecoverse/wasm-bash/': ['package.json', 'bin/bash', 'bin/bash.wasm'],
  'node_modules/@ai-ecoverse/wasm-curl/': ['package.json', 'bin/curl', 'bin/curl.wasm'],
  'node_modules/@ai-ecoverse/wasm-tls-engine/': [
    'package.json',
    'dist/slicc-tls-engine.mjs',
    'dist/slicc-tls-engine.wasm',
  ],
  'node_modules/@ai-ecoverse/wasm-coreutils/': [
    'package.json',
    'bin/coreutils',
    'bin/coreutils.wasm',
  ],
};

function ask(worker, message) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage(message);
  });
}

async function walk(path, create = false) {
  let dir = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

async function file(path, create = false) {
  const parts = path.split('/');
  const name = parts.pop();
  return (await walk(parts.join('/'), create)).getFileHandle(name, { create });
}

async function install() {
  for (const [dir, names] of Object.entries(packages)) {
    for (const name of names) {
      const source = dir.replace(/^node_modules\/(?!@)/, 'fixtures/');
      const bytes = await fetchBytes(`/${source}${name}`);
      const writable = await (await file(dir + name, true)).createWritable();
      await writable.write(bytes);
      await writable.close();
    }
  }
}

async function fetchBytes(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.arrayBuffer();
  } catch (err) {
    throw new Error(`fetching ${url}: ${err}`);
  }
}

window.installTree = async (dir, names) => {
  const dirs = new Set(names.map((name) => (dir + name).split('/').slice(0, -1).join('/')));
  for (const path of [...dirs].sort()) await walk(path, true);
  let next = 0;
  const copy = async () => {
    while (next < names.length) {
      const name = names[next++];
      const bytes = await fetchBytes(`/${dir}${name}`);
      const parts = (dir + name).split('/');
      const base = parts.pop();
      const handle = await (await walk(parts.join('/'))).getFileHandle(base, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }
  };
  await Promise.all(Array.from({ length: 8 }, copy));
  return names.length;
};

window.probe = async () => {
  const worker = new Worker(new URL('./probe-worker.js', import.meta.url), { type: 'module' });
  const report = await ask(worker, { depth: 1 });
  worker.terminate();
  return { isolated: crossOriginIsolated, workers: report };
};

window.boot = async (options = {}) => {
  await install();
  const transport = options.proxy
    ? localProxyTransport(options.proxy)
    : fetchTransport(options.hint ? { hint: options.hint } : {});
  const network = options.network === false ? {} : { network: { transport } };
  window.kernel = await createKernel({ root: await navigator.storage.getDirectory(), ...network });
  return true;
};

window.probeLocalProxy = probeLocalProxy;
window.checkLocalProxy = checkLocalProxy;

window.opfs = {
  async read(path) {
    return (await (await file(path)).getFile()).text().catch(() => null);
  },
  async write(path, text) {
    const writable = await (await file(path, true)).createWritable();
    await writable.write(text);
    await writable.close();
  },
  async list(path) {
    const names = [];
    for await (const name of (await walk(path)).keys()) names.push(name);
    return names.sort();
  },
  async exists(path) {
    return file(path).then(
      () => true,
      () =>
        walk(path).then(
          () => true,
          () => false
        )
    );
  },
};

window.terminal = async (argv, options) => {
  const decoder = new TextDecoder();
  const state = { screen: '', status: null };
  const term = await window.kernel.openTerminal(argv, options);
  term.onData = (bytes) => {
    state.screen += decoder.decode(bytes, { stream: true });
  };
  term.exited.then((status) => {
    state.status = status;
  });
  window.term = term;
  window.screen = state;
  return term.pid;
};

window.reboot = async () => {
  window.kernel.terminate();
  window.kernel = await createKernel({ root: await navigator.storage.getDirectory() });
  return true;
};

window.remove = async (path) => {
  const parts = path.split('/');
  const name = parts.pop();
  await (await walk(parts.join('/'))).removeEntry(name, { recursive: true });
  return true;
};
