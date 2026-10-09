import {
  attachKernel,
  checkLocalProxy,
  createKernel,
  fetchTransport,
  localProxyTransport,
  probeLocalProxy,
} from '/dist/index.js';

const packages = {
  'node_modules/socktest/': ['package.json', 'bin/socktest', 'bin/socktest.wasm'],
  'node_modules/mounttest/': ['package.json', 'bin/mounttest.wasm'],
  'node_modules/httptest/': ['package.json', 'bin/httptest.wasm'],
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

const inFlight = new Set();

async function tracked(what, work) {
  const entry = { what, since: Date.now() };
  inFlight.add(entry);
  try {
    return await work(entry);
  } finally {
    inFlight.delete(entry);
  }
}

window.inFlight = () => [...inFlight].map((e) => ({ ...e, ms: Date.now() - e.since }));

const STALL = 30000;

function fetchOnce(url) {
  return tracked(`fetch ${url}`, async (entry) => {
    entry.bytes = 0;
    entry.last = Date.now();
    const controller = new AbortController();
    const watch = setInterval(() => {
      if (Date.now() - entry.last > STALL) {
        controller.abort(Object.assign(new Error(`no data for ${STALL} ms`), { stalled: true }));
      }
    }, 1000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status}`);
      const reader = response.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        entry.bytes += value.length;
        entry.last = Date.now();
      }
      const out = new Uint8Array(entry.bytes);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    } catch (err) {
      const ms = Date.now() - entry.since;
      const reason = controller.signal.reason ?? err;
      throw Object.assign(
        new Error(`fetching ${url}: ${reason}, after ${entry.bytes} bytes in ${ms} ms`),
        { stalled: reason?.stalled === true, bytes: entry.bytes }
      );
    } finally {
      clearInterval(watch);
    }
  });
}

const stalls = [];

window.takeStalls = () => stalls.splice(0);

async function fetchBytes(url) {
  try {
    return await fetchOnce(url);
  } catch (err) {
    if (!err.stalled) throw err;
    stalls.push(`chrome stalled on ${url} after ${err.bytes} bytes; re-fetched`);
    return fetchOnce(url);
  }
}

window.copyTree = async (from, to, names) => {
  for (const name of names) {
    const parts = (to + name).split('/');
    const base = parts.pop();
    const handle = await (await walk(parts.join('/'), true)).getFileHandle(base, { create: true });
    const writable = await handle.createWritable();
    await writable.write(await fetchBytes(`/${from}${name}`));
    await writable.close();
  }
  return names.length;
};

window.objects = new Map();

function storeTransport(inner) {
  const reply = (status, bytes = new Uint8Array(0)) => ({
    status,
    statusText: '',
    headers: [],
    body: (async function* () {
      if (bytes.length) yield bytes;
    })(),
    cancel: async () => {},
  });
  return {
    traits: inner.traits,
    async fetch(req) {
      if (!req.url.startsWith('http://mock-s3.test/')) return inner.fetch(req);
      const url = new URL(req.url);
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ''));
      const objects = window.objects;
      if (req.method === 'GET' && url.searchParams.has('list')) {
        const prefix = url.searchParams.get('list');
        const listed = [...objects]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, o]) => ({ key: k, size: o.body.length, mtime: o.mtime }));
        return reply(200, new TextEncoder().encode(JSON.stringify(listed)));
      }
      if (req.method === 'PUT') {
        if (window.refusePuts) return reply(503);
        objects.set(key, { body: req.body ?? new Uint8Array(0), mtime: Date.now() });
        return reply(200);
      }
      if (!objects.has(key)) return reply(404);
      if (req.method === 'DELETE') {
        objects.delete(key);
        return reply(200);
      }
      return reply(200, objects.get(key).body);
    },
  };
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

function withTracking(kernel) {
  const run = kernel.run.bind(kernel);
  kernel.run = (argv, options) => tracked(`run ${JSON.stringify(argv)}`, () => run(argv, options));
  return kernel;
}

window.pendingMedia = [];

const media = {
  requestDirectory: () => walk('picked', true),
  onMountPending: (pending) => window.pendingMedia.push(pending),
  hostfs: async (source, { readonly }) => {
    const { url, key } = window.hostfsProxy;
    const response = await fetch(`${url}/api/hostfs/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': key },
      body: JSON.stringify({ mount: source, readonly }),
    });
    if (!response.ok) throw new Error(`grant refused: ${response.status}`);
    return { url, ...(await response.json()) };
  },
};

window.insertPending = async (index) => {
  await window.pendingMedia[index].insert();
  return true;
};

window.boot = async (options = {}) => {
  await install();
  const base = options.proxy
    ? localProxyTransport(options.proxy)
    : fetchTransport(options.hint ? { hint: options.hint } : {});
  const transport = options.store ? storeTransport(base) : base;
  const network = options.network === false ? {} : { network: { transport } };
  const policy =
    options.processMounts === undefined ? {} : { processMounts: options.processMounts };
  const handles = options.media === undefined ? {} : { media: options.media };
  window.kernel = withTracking(
    await createKernel({
      root: await navigator.storage.getDirectory(),
      ...network,
      ...media,
      ...policy,
      ...handles,
    })
  );
  return true;
};

window.secondKernel = async (options, name = 'second') => {
  window[name] = await createKernel({
    root: await navigator.storage.getDirectory(),
    network: { transport: fetchTransport() },
    ...options,
  });
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
  window.kernel = withTracking(
    await createKernel({ root: await navigator.storage.getDirectory(), ...media })
  );
  return true;
};

window.remove = async (path) => {
  const parts = path.split('/');
  const name = parts.pop();
  await (await walk(parts.join('/'))).removeEntry(name, { recursive: true });
  return true;
};

window.attachKernel = attachKernel;

window.agent = () => {
  const worker = new Worker(new URL('./agent-worker.js', import.meta.url), { type: 'module' });
  const events = [];
  const waiting = new Map();
  let id = 0;
  worker.onmessage = ({ data }) => {
    if (data.event) events.push(data);
    else waiting.get(data.id)?.(data);
  };
  const ask = (action, payload = {}, transfer = []) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (d) => (d.error ? reject(new Error(d.error)) : resolve(d.result)));
      worker.postMessage({ id: n, action, ...payload }, transfer);
    });
  return { worker, events, ask };
};
