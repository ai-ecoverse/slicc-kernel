import {
  attachKernel,
  checkLocalProxy,
  createKernel,
  fetchTransport,
  localProxyTransport,
  probeLocalProxy,
  serveHostfsPort,
} from '/dist/index.js';

const packages = {
  'node_modules/locktry/': ['package.json', 'locktry.wasm', 'host.mjs'],
  'node_modules/socktest/': ['package.json', 'bin/socktest', 'bin/socktest.wasm'],
  'node_modules/mounttest/': ['package.json', 'bin/mounttest.wasm'],
  'node_modules/httptest/': ['package.json', 'bin/httptest.wasm'],
  'node_modules/ttytest/': ['package.json', 'bin/ttytest.wasm'],
  'node_modules/statfstest/': ['package.json', 'bin/statfstest.mjs'],
  'node_modules/watchtest/': ['package.json', 'bin/watchtest.mjs'],
  'node_modules/jstest/': [
    'package.json',
    'bin/jstest.mjs',
    'bin/nomain.mjs',
    'bin/broken.mjs',
    'bin/echo.mjs',
  ],
  'node_modules/@ai-ecoverse/wasm-bash/': ['package.json', 'bin/bash', 'bin/bash.wasm'],
  'node_modules/@ai-ecoverse/wasm-curl/': ['package.json', 'bin/curl', 'bin/curl.wasm'],
  'node_modules/@ai-ecoverse/wasm-tls-engine/': [
    'package.json',
    'dist/slicc-tls-engine.mjs',
    'dist/slicc-tls-engine.wasm',
    'dist/roots.der',
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

function same(have, want) {
  if (have.length !== want.length) return false;
  for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
  return true;
}

async function install() {
  for (const [dir, names] of Object.entries(packages)) {
    for (const name of names) {
      const source = dir.replace(/^node_modules\/(?!@)/, 'fixtures/');
      const bytes = await fetchBytes(`/${source}${name}`);
      const handle = await file(dir + name, true);
      if (same(new Uint8Array(await (await handle.getFile()).arrayBuffer()), bytes)) continue;
      const writable = await handle.createWritable();
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

const STALL = 12000;

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
        { stalled: reason?.stalled === true, bytes: entry.bytes, ms }
      );
    } finally {
      clearInterval(watch);
    }
  });
}

const stalls = [];
const large = [];
const LARGE = 20 * 1024 * 1024;
const RETRIES = 3;

window.takeStalls = () => stalls.splice(0);
window.takeLargeFetches = () => large.splice(0);

async function fetchBytes(url) {
  const start = Date.now();
  for (let retry = 0; ; retry++) {
    const attempt = Date.now();
    try {
      const bytes = await fetchOnce(url);
      if (bytes.length > LARGE || retry > 0) {
        large.push(
          `chrome fetched ${url}: ${bytes.length} bytes in ${Date.now() - start} ms, ${retry} re-fetches`
        );
      }
      return bytes;
    } catch (err) {
      if (!err.stalled) throw err;
      stalls.push(
        `chrome stalled on ${url} (attempt ${retry + 1}) after ${err.bytes} bytes ` +
          `(no data for ${STALL / 1000} s, ${((Date.now() - attempt) / 1000).toFixed(1)} s in)` +
          (retry < RETRIES ? '; re-fetching' : '; giving up')
      );
      if (retry === RETRIES) throw err;
    }
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

function uploadSink(inner, maxRequestBody) {
  let seen;
  window.firstPart = new Promise((resolve) => {
    seen = resolve;
  });
  const hex = (buffer) =>
    Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
  return {
    traits: { ...inner.traits, maxRequestBody, streamingBodies: true },
    async fetch(req) {
      if (!req.url.startsWith('http://upload-sink.test/')) return inner.fetch(req);
      const parts = [];
      let length = 0;
      for await (const part of req.bodyStream ?? (req.body ? [req.body] : [])) {
        if (length === 0) seen(new TextDecoder().decode(part));
        parts.push(part);
        length += part.length;
      }
      const all = new Uint8Array(length);
      let at = 0;
      for (const part of parts) {
        all.set(part, at);
        at += part.length;
      }
      const digest = hex(await crypto.subtle.digest('SHA-256', all));
      const text = `${req.bodyStream ? 'stream' : 'whole'} ${length} ${digest}`;
      return {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/plain']],
        body: (async function* () {
          yield new TextEncoder().encode(text);
        })(),
        cancel: async () => {},
      };
    },
  };
}

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
window.hostfsPorts = [];
window.hostfsStall = false;
window.dropHostfsPort = () => {
  const last = window.hostfsPorts.at(-1);
  last.port.onmessage = null;
  last.stop();
};

function pageHostfs(grant) {
  const send = async (path, init) => {
    const response = await fetch(`${grant.url}${path}`, {
      ...init,
      headers: { ...init.headers, 'X-Hostfs-Token': grant.token },
    });
    if (response.ok) return response;
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.message ?? 'EIO'), {
      code: response.headers.get('X-Hostfs-Errno') ?? 'EIO',
    });
  };
  const json = { 'Content-Type': 'application/json' };
  const stall = () => (window.hostfsStall ? new Promise(() => {}) : null);
  return {
    capabilities: grant.capabilities ?? {},
    token: grant.token,
    maxIo: grant.capabilities?.maxIo ?? 16 * 1024 * 1024,
    async call(op, body = {}) {
      await stall();
      const r = await send('/api/hostfs', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ op, ...body }),
      });
      return r.json();
    },
    async read(fh, offset, size, ifMatch) {
      await stall();
      const body = JSON.stringify({
        op: 'read',
        fh,
        offset,
        size,
        ...(ifMatch ? { ifMatch } : {}),
      });
      const r = await send('/api/hostfs', { method: 'POST', headers: json, body });
      return new Uint8Array(await r.arrayBuffer());
    },
    async write(fh, offset, bytes) {
      await stall();
      await send('/api/hostfs/write', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Hostfs-Request': JSON.stringify({ fh, offset }),
        },
        body: bytes,
      });
    },
    async watch(signal, onEvent, onOpen) {
      const r = await send('/api/hostfs/watch', { method: 'POST', headers: {}, signal });
      onOpen?.();
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop();
          for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
        }
      } catch (err) {
        if (!signal.aborted) throw Object.assign(err, { code: 'ENOTCONN' });
      }
    },
  };
}

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
    const grant = { url, ...(await response.json()) };
    if (!window.hostfsOverPort) return grant;
    const { port1, port2 } = new MessageChannel();
    window.hostfsPorts.push({ port: port2, stop: serveHostfsPort(port2, pageHostfs(grant)) });
    return {
      port: port1,
      token: `page-${window.hostfsPorts.length}`,
      capabilities: grant.capabilities,
    };
  },
};

window.insertPending = async (index) => {
  await window.pendingMedia[index].insert();
  return true;
};

const cdpLinks = new Map();
let cdpNext = 0;

window.cdpIn = (id, message, closed) => {
  const conn = cdpLinks.get(id);
  if (!conn) return false;
  if (closed === undefined) conn.onmessage?.(message);
  else {
    cdpLinks.delete(id);
    conn.onclose?.(closed || undefined);
  }
  return true;
};

const cdpHook = async (request) => {
  const id = ++cdpNext;
  const out = (message) => window.cdpOut(JSON.stringify({ id, ...message }));
  const conn = {
    onmessage: null,
    onclose: null,
    send: (m) => out({ m }),
    close: () => {
      if (cdpLinks.delete(id)) out({ close: true });
    },
  };
  cdpLinks.set(id, conn);
  out({ open: request });
  return conn;
};

window.clipboard = { text: '', refuse: false, calls: [] };

const clipboardHook = {
  read: async (stamp) => {
    window.clipboard.calls.push({ op: 'read', stamp });
    if (window.clipboard.refuse) {
      throw new DOMException('The clipboard needs the tab in front', 'NotAllowedError');
    }
    return window.clipboard.text;
  },
  write: async (text, stamp) => {
    window.clipboard.calls.push({ op: 'write', text, stamp });
    if (window.clipboard.refuse) {
      throw new DOMException('The clipboard needs the tab in front', 'NotAllowedError');
    }
    window.clipboard.text = text;
  },
};

window.extraTraits = {};

const liveTraits = (inner) => ({
  fetch: (...args) => inner.fetch(...args),
  ...(inner.websocket ? { websocket: (...args) => inner.websocket(...args) } : {}),
  get traits() {
    return { ...inner.traits, ...window.extraTraits };
  },
});

window.integrityAsked = [];

function protection({ hashes, unknown, ...rest }) {
  if (!hashes) return rest;
  const lookup = async (path) => {
    window.integrityAsked.push(path);
    return hashes[path];
  };
  return { ...rest, integrity: { lookup, ...(unknown ? { unknown } : {}) } };
}

window.boot = async (options = {}) => {
  await install();
  const base = options.proxy
    ? localProxyTransport(options.proxy)
    : fetchTransport(options.hint ? { hint: options.hint } : {});
  const sunk = options.uploadSink ? uploadSink(base, options.uploadSink) : base;
  const stored = options.store ? storeTransport(sunk) : sunk;
  const transport = options.liveTraits ? liveTraits(stored) : stored;
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
      ...(options.cdp ? { cdp: cdpHook } : {}),
      ...(options.protect ? { protect: protection(options.protect) } : {}),
      ...(options.clipboard ? { clipboard: clipboardHook } : {}),
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
