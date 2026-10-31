import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attachKernel,
  createNodeKernel,
  nodeTransport,
  SEALED_FETCH_VERSION,
} from '../../dist/node.js';
import {
  placeholderFloor,
  sealedAnswerer,
  sealedAsker,
  sealedFetcher,
} from '../../dist/testing.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const PH = 'fnox_proxy_0123456789abcdef01234567';
const REFUSED = /refused: this request has a sealed placeholder/;
const UNFINISHED = /refused: the request with a sealed placeholder was not completed/;
const CURL = ['wasm-bash', 'wasm-curl', 'wasm-tls-engine'];
const ORDINARY = 'https://fake.test/ordinary';

const PACKAGE = JSON.stringify({
  name: 'fillprobe',
  slicc: { commands: { fillprobe: { abi: 'js', module: 'bin/fillprobe.mjs' } } },
});

const PROGRAM = `const why = (e) => 'error ' + (e.cause?.code ?? e.code) + ' ' + (e.cause?.message ?? e.message);
const steps = {
  fetch: ({ url, init }, ctx) =>
    ctx.fetch(url, init).then(async (r) => r.status + ' ' + (await r.text())).catch(why),
  websocket: ({ url, init }, ctx) =>
    ctx.websocket(url, init).then((s) => { s.close(); return 'open'; }, why),
  upload: async ({ url, init, chunks, size }, ctx) => {
    let pulled = 0;
    const body = new ReadableStream({
      pull(c) {
        if (pulled === chunks) return c.close();
        pulled++;
        c.enqueue(new Uint8Array(size).fill(pulled));
      },
    }, { highWaterMark: 0 });
    return ctx.fetch(url, { ...init, method: 'POST', body, duplex: 'half' })
      .then(async (r) => r.status + ' ' + (await r.text()), why);
  },
  setcred: ({ change }, ctx) => ctx.sync.setcred(change).euid,
  socket: async ({ change, restore, turns }, ctx) => {
    const conn = await ctx.net.connect({ host: '127.0.0.1', port: 3128 });
    if (change) ctx.sync.setcred(change);
    const writer = conn.writable.getWriter();
    const reader = conn.readable.getReader();
    const out = [];
    for (const { send, until } of turns) {
      await writer.write(new TextEncoder().encode(send));
      let text = '';
      while (!new RegExp(until).test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      out.push(text);
    }
    await conn.close();
    if (restore) ctx.sync.setcred(restore);
    return out;
  },
  firstChunk: async ({ url, init }, ctx) => {
    const r = await ctx.fetch(url, init).catch(why);
    if (typeof r === 'string') return r;
    const reader = r.body.getReader();
    const { value } = await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await reader.cancel();
    return r.status + ' ' + new TextDecoder().decode(value);
  },
  abort: async ({ url, init }, ctx) => {
    const control = new AbortController();
    const asked = ctx.fetch(url, { ...init, signal: control.signal }).catch(why);
    await new Promise((resolve) => setTimeout(resolve, 100));
    control.abort();
    const got = await asked;
    return typeof got === 'string' ? got : 'answered ' + got.status;
  },
  setup: async (_, ctx) => {
    await ctx.fs.mkdir('/etc/open');
    await ctx.fs.chmod('/etc/open', 0o777);
    await ctx.fs.symlink('/etc/slicc', '/etc/linked');
    await ctx.fs.symlink('/nowhere', '/etc/slicc/dangling');
    await ctx.fs.writeFile('/etc/slicc/file', 'x');
    return 'done';
  },
};
export default async function main(ctx) {
  const out = [];
  for (const step of JSON.parse(ctx.argv[1])) out.push(await steps[step.kind](step, ctx));
  await ctx.write(1, JSON.stringify(out));
}
`;

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function receiver(t) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('delivered');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port: server.address().port };
}

function wired(port, traits = {}) {
  const wire = nodeTransport({ hostLoopback: [port] });
  const calls = [];
  return {
    calls,
    get traits() {
      return { ...wire.traits, ...traits };
    },
    fetch(request, owner, stamp) {
      calls.push({ url: request.url, headers: request.headers, owner, stamp });
      const { pathname, search } = new URL(request.url);
      return wire.fetch({ ...request, url: `http://127.0.0.1:${port}${pathname}${search}` }, owner);
    },
    async websocket() {
      calls.push({ websocket: true });
      throw new Error('the raw websocket ran');
    },
  };
}

function scrubbed(text, { status = 200, headers = [['content-type', 'text/plain']] } = {}) {
  let cancelled = 0;
  return {
    status,
    statusText: 'Filled',
    headers,
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
    cancel: async () => {
      cancelled++;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

async function booted(t, options, packages = []) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  for (const name of packages) await install(kernel, name);
  await kernel.writeFile('/node_modules/fillprobe/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/fillprobe/bin/fillprobe.mjs', PROGRAM);
  const curl = (args, runOptions = {}) =>
    kernel.run(['bash', '-c', `curl -sS -w ' %{http_code}' ${args}`], {
      cwd: '/',
      ...runOptions,
    });
  const probe = async (steps, runOptions = {}) => {
    const { stdout, stderr } = await kernel.run(['fillprobe', JSON.stringify(steps)], {
      cwd: '/',
      ...runOptions,
    });
    assert.equal(stderr, '');
    return JSON.parse(stdout);
  };
  return { kernel, curl, probe };
}

const noRequest = async () => {
  throw new Error('the /dev/sealed hook ran');
};

const bearer = { headers: { authorization: `Bearer ${PH}` } };

test('SEALED_FETCH_VERSION is the number 1 on the Node entry', () => {
  assert.equal(SEALED_FETCH_VERSION, 1);
});

test('curl and ctx.fetch reach the fetch hook with the stamp and flat fields, and the program gets the scrubbed response', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const asked = [];
  const fetch = async (req, { signal }) => {
    assert.equal(signal.aborted, false);
    const parts = [];
    for await (const part of req.bodyStream ?? []) parts.push(Buffer.from(part));
    asked.push({ ...req, sent: Buffer.concat([...parts, Buffer.from(req.body ?? [])]).toString() });
    return scrubbed(`scrubbed ${req.method}`, { status: 201 });
  };
  const { kernel, curl, probe } = await booted(
    t,
    { network: { transport }, sealed: { request: noRequest, fetch } },
    CURL
  );
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  const [cone] = (await kernel.users.list()).filter((u) => u.name === 'cone');

  const fromCurl = await curl(`-H "Authorization: Bearer $TOKEN" -X PUT -d hello ${ORDINARY}`, {
    env: { TOKEN: PH },
    user: 'cone',
    tag: 'cone-tag',
  });
  assert.equal(fromCurl.stdout, 'scrubbed PUT 201');

  const fromFetch = await probe(
    [{ kind: 'fetch', url: `https://fake.test/?k=${PH}`, init: { method: 'POST', body: 'x' } }],
    { user: 'cone' }
  );
  assert.deepEqual(fromFetch, ['201 scrubbed POST']);
  const encrypted = await curl(`-H "x-api-key: ${PH}" -k ${ORDINARY}`);
  assert.equal(encrypted.stdout, 'scrubbed GET 201');

  assert.equal(seen.length, 0);
  assert.equal(transport.calls.length, 0);
  assert.equal(asked.length, 3);

  const [viaProxy, viaFetch, viaRoot] = asked;
  assert.equal(viaProxy.v, 1);
  assert.equal(viaProxy.method, 'PUT');
  assert.equal(viaProxy.url, ORDINARY);
  assert.equal(viaProxy.redirect, 'manual');
  assert.ok(viaProxy.headers.some(([n, v]) => n === 'Authorization' && v === `Bearer ${PH}`));
  assert.equal(viaProxy.sent, 'hello');
  for (const { caller } of [viaProxy, viaFetch]) {
    assert.equal(caller.uid, cone.uid);
    assert.equal(caller.gid, cone.gid);
    assert.equal(caller.user, 'cone');
    assert.deepEqual([...caller.groups].sort(), [...cone.groups].sort());
    assert.equal(caller.users, 'enforce');
    assert.ok(Number.isInteger(caller.pid) && caller.pid > 0);
  }
  assert.equal(viaProxy.caller.tag, 'cone-tag');
  assert.equal(viaFetch.method, 'POST');
  assert.equal(viaFetch.url, `https://fake.test/?k=${PH}`);
  assert.equal(viaFetch.sent, 'x');
  assert.equal(viaRoot.caller.uid, 0);
  assert.equal(viaRoot.caller.users, 'enforce');
});

test('requests without a placeholder stay on the transport, with the owner and stamp beside them', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const asked = [];
  const fetch = async (req) => {
    asked.push(req);
    return scrubbed('filled');
  };
  const { curl, probe } = await booted(
    t,
    { network: { transport }, sealed: { request: noRequest, fetch } },
    CURL
  );
  assert.deepEqual(await probe([{ kind: 'fetch', url: 'https://fake.test/plain' }]), [
    '200 delivered',
  ]);
  assert.equal((await curl('https://fake.test/plain')).stdout, 'delivered 200');
  assert.equal(asked.length, 0);
  assert.equal(seen.length, 2);
  for (const { owner, stamp } of transport.calls) {
    assert.ok(Number.isInteger(owner) && owner > 0);
    assert.equal(stamp.uid, 0);
    assert.equal(stamp.users, 'enforce');
  }
});

const REFUSALS = [
  ['no sealed option', undefined, 'enforce', REFUSED],
  ['a bare function', noRequest, 'enforce', REFUSED],
  ['no fetch hook', { request: noRequest }, 'enforce', REFUSED],
  [
    'users off',
    {
      request: noRequest,
      fetch: async () => {
        throw new Error('the fetch hook ran');
      },
    },
    'off',
    REFUSED,
  ],
  [
    'users report',
    {
      request: noRequest,
      fetch: async () => {
        throw new Error('the fetch hook ran');
      },
    },
    'report',
    REFUSED,
  ],
  [
    'a hook that throws',
    {
      request: noRequest,
      fetch: async () => {
        throw new Error('no rule');
      },
    },
    'enforce',
    /refused: the request with a sealed placeholder was not completed: no rule/,
  ],
  [
    'a reply with redirect hops',
    {
      request: noRequest,
      fetch: async () => ({
        ...scrubbed('hops'),
        redirects: [{ status: 302, url: 'https://x.test/', headers: [] }],
      }),
    },
    'enforce',
    UNFINISHED,
  ],
  [
    'an empty list of redirect hops',
    { request: noRequest, fetch: async () => ({ ...scrubbed('hops'), redirects: [] }) },
    'enforce',
    UNFINISHED,
  ],
  [
    'a reply that followed a redirect',
    { request: noRequest, fetch: async () => ({ ...scrubbed('x'), redirected: true }) },
    'enforce',
    UNFINISHED,
  ],
  [
    'a reply that is not a response',
    { request: noRequest, fetch: async () => ({}) },
    'enforce',
    UNFINISHED,
  ],
  [
    'header injection in a reply',
    {
      request: noRequest,
      fetch: async () => scrubbed('x', { headers: [['x-a', 'b\r\nset-cookie: y']] }),
    },
    'enforce',
    UNFINISHED,
  ],
];

for (const [name, sealed, users, reason] of REFUSALS) {
  test(`${name}: curl and ctx.fetch are refused and the receiver counts nothing`, async (t) => {
    const { seen, port } = await receiver(t);
    const transport = wired(port);
    const { curl, probe } = await booted(
      t,
      { users, network: { transport }, ...(sealed ? { sealed } : {}) },
      CURL
    );
    const fromCurl = await curl(`-H "Authorization: Bearer ${PH}" ${ORDINARY}`);
    assert.match(fromCurl.stdout, reason);
    assert.match(fromCurl.stdout, / 403$/);
    const [fromFetch] = await probe([{ kind: 'fetch', url: ORDINARY, init: bearer }]);
    assert.match(fromFetch, /^error EACCES /);
    assert.match(fromFetch, reason);
    assert.equal(seen.length, 0);
    assert.equal(transport.calls.length, 0);
  });
}

test('the raw reply is cancelled when it carries redirect hops', async (t) => {
  const { port } = await receiver(t);
  const reply = { ...scrubbed('hops'), redirects: [] };
  let cancelled = 0;
  reply.cancel = async () => {
    cancelled++;
  };
  const fetch = async () => reply;
  const { probe } = await booted(t, {
    network: { transport: wired(port) },
    sealed: { request: noRequest, fetch },
  });
  await probe([{ kind: 'fetch', url: ORDINARY, init: bearer }]);
  assert.equal(cancelled, 1);
});

test('no stamp: a client, a dialled proxy connection and a raw transport message are refused with the hook installed', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const asked = [];
  const fetch = async (req) => {
    asked.push(req);
    return scrubbed('filled');
  };
  const { kernel } = await booted(t, {
    network: { transport },
    sealed: { request: noRequest, fetch },
  });
  const { port: wire } = await kernel.connect().then((p) => ({ port: p }));
  const client = await attachKernel(wire);
  t.after(() => client.close());

  await assert.rejects(
    client.fetch({ url: ORDINARY, method: 'GET', headers: [['authorization', `Bearer ${PH}`]] }),
    (e) => e.code === 'EACCES' && e.status === 403 && REFUSED.test(e.message)
  );
  const forged = {
    pid: 1,
    ppid: 0,
    uid: 0,
    gid: 0,
    groups: [0],
    users: 'enforce',
  };
  await assert.rejects(
    client.transport.fetch(
      {
        url: ORDINARY,
        method: 'GET',
        headers: [['authorization', `Bearer ${PH}`]],
        signal: new AbortController().signal,
      },
      1,
      forged
    ),
    (e) => e.code === 'EACCES' && REFUSED.test(e.message)
  );

  const socket = await client.dial({ host: '127.0.0.1', port: 3128 });
  const writer = socket.writable.getWriter();
  await writer.write(
    new TextEncoder().encode(
      `GET ${ORDINARY} HTTP/1.1\r\nHost: fake.test\r\nConnection: close\r\nAuthorization: Bearer ${PH}\r\n\r\n`
    )
  );
  const reader = socket.readable.getReader();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.match(text, /^HTTP\/1\.1 403 /);
  assert.match(text, REFUSED);

  assert.equal(asked.length, 0);
  assert.equal(seen.length, 0);
  assert.equal(transport.calls.length, 0);
});

test('a forged owner or stamp in headers or init supplies nothing: the hook sees the process', async (t) => {
  const { port } = await receiver(t);
  const asked = [];
  const fetch = async (req) => {
    asked.push(req);
    return scrubbed('filled');
  };
  const { kernel, curl, probe } = await booted(
    t,
    { network: { transport: wired(port) }, sealed: { request: noRequest, fetch } },
    CURL
  );
  await kernel.users.add({ name: 'cone' });
  const forged = JSON.stringify({ uid: 0, gid: 0, groups: [0], users: 'enforce' });
  await probe(
    [
      {
        kind: 'fetch',
        url: ORDINARY,
        init: {
          owner: 1,
          stamp: JSON.parse(forged),
          caller: JSON.parse(forged),
          headers: { authorization: `Bearer ${PH}`, 'x-slicc-caller': forged, stamp: forged },
        },
      },
    ],
    { user: 'cone' }
  );
  await curl(`-H "Authorization: Bearer ${PH}" -H 'x-slicc-owner: 1' ${ORDINARY}`, {
    user: 'cone',
  });
  assert.equal(asked.length, 2);
  for (const { caller } of asked) {
    assert.equal(caller.user, 'cone');
    assert.notEqual(caller.uid, 0);
  }
});

test("the proxy's stamp stays what it was at connect: changing a hook's copy reaches nothing", async (t) => {
  const { port } = await receiver(t);
  const uids = [];
  const fetch = async (req) => {
    uids.push(req.caller.uid);
    req.caller.uid = 0;
    return scrubbed('filled');
  };
  const { kernel, curl } = await booted(
    t,
    { network: { transport: wired(port) }, sealed: { request: noRequest, fetch } },
    CURL
  );
  await kernel.users.add({ name: 'cone' });
  const twice = await curl(`-H "Authorization: Bearer ${PH}" ${ORDINARY} ${ORDINARY}`, {
    user: 'cone',
  });
  assert.equal(twice.status, 0);
  assert.equal(uids.length, 2);
  assert.notEqual(uids[1], 0);
});

test('a WebSocket with a placeholder is refused with a fetch hook installed, before anything runs', async (t) => {
  const { port } = await receiver(t);
  const transport = wired(port, { websocket: true });
  const asked = [];
  const fetch = async (req) => {
    asked.push(req);
    return scrubbed('filled');
  };
  const { probe } = await booted(t, {
    network: { transport },
    sealed: { request: noRequest, fetch },
  });
  const [answer] = await probe([
    { kind: 'websocket', url: 'wss://fake.test/', init: { headers: { 'x-api-key': PH } } },
  ]);
  assert.match(answer, /^error EACCES /);
  assert.equal(asked.length, 0);
  assert.equal(transport.calls.length, 0);
});

test('an abort reaches the hook, the receiver counts nothing and the program sees it fail', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const aborted = Promise.withResolvers();
  const fetch = (_, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted.resolve(signal.reason);
        reject(new Error('the hook stopped'));
      });
    });
  const { probe } = await booted(t, {
    network: { transport },
    sealed: { request: noRequest, fetch },
  });
  const [answer] = await probe([{ kind: 'abort', url: ORDINARY, init: bearer }]);
  assert.match(answer, /^error /);
  await aborted.promise;
  assert.equal(seen.length, 0);
  assert.equal(transport.calls.length, 0);
});

test('terminating the kernel aborts a hook that is waiting', async (t) => {
  const { port } = await receiver(t);
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const fetch = (_, { signal }) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted.resolve(signal.reason);
        reject(new Error('stopped'));
      });
    });
  };
  const kernel = await createNodeKernel({
    network: { transport: wired(port) },
    sealed: { request: noRequest, fetch },
  });
  await kernel.writeFile('/node_modules/fillprobe/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/fillprobe/bin/fillprobe.mjs', PROGRAM);
  const running = kernel
    .run(['fillprobe', JSON.stringify([{ kind: 'fetch', url: ORDINARY, init: bearer }])], {
      cwd: '/',
    })
    .catch(() => undefined);
  await started.promise;
  kernel.terminate();
  assert.equal(await aborted.promise, 'terminated');
  await running;
});

for (const [name, stopped] of [
  ['a request aborted before the hook is asked', false],
  ['a kernel that has terminated', true],
]) {
  test(`${name}: the hook is not called and the receiver counts nothing`, async (t) => {
    const { seen, port } = await receiver(t);
    const transport = wired(port);
    let asked = 0;
    const hook = async () => {
      asked++;
      return scrubbed('filled');
    };
    const stop = new AbortController();
    const control = new AbortController();
    (stopped ? stop : control).abort('gone');
    const floor = placeholderFloor(transport, { fill: sealedFetcher(hook, stop.signal) });
    const stamp = { pid: 2, ppid: 1, uid: 1000, gid: 1000, groups: [], users: 'enforce' };
    await assert.rejects(
      floor.fetch(
        {
          url: ORDINARY,
          method: 'GET',
          headers: [['authorization', `Bearer ${PH}`]],
          signal: control.signal,
        },
        2,
        stamp
      ),
      (e) => e.code === 'EACCES' && UNFINISHED.test(e.message)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asked, 0);
    assert.equal(seen.length, 0);
    assert.equal(transport.calls.length, 0);
  });
}

const SYSCALL_HOOK = Symbol.for('slicc-kernel.test.syscall');
const ENDED = '\r\n0\r\n\r\n$';
const HEAD_ENDED = '\r\n\r\n$';

function get(path, placeholder = PH, connection = 'keep-alive') {
  return (
    `GET ${path} HTTP/1.1\r\nHost: fake.test\r\nConnection: ${connection}\r\n` +
    `Authorization: Bearer ${placeholder}\r\n\r\n`
  );
}

function recordingHook(asked) {
  return async (req) => {
    asked.push(req);
    return scrubbed('filled');
  };
}

async function coneIds(kernel) {
  const { uid, gid } = await kernel.users.add({ name: 'cone' });
  return { uid, gid };
}

test('a process that changes its effective uid between two ctx.fetch calls is stamped with the uid of each call', async (t) => {
  const { port } = await receiver(t);
  const asked = [];
  const { kernel, probe } = await booted(t, {
    network: { transport: wired(port) },
    sealed: { request: noRequest, fetch: recordingHook(asked) },
  });
  const cone = await coneIds(kernel);
  const answers = await probe([
    { kind: 'fetch', url: ORDINARY, init: bearer },
    { kind: 'setcred', change: { egid: cone.gid, groups: [cone.gid] } },
    { kind: 'setcred', change: { euid: cone.uid } },
    { kind: 'fetch', url: ORDINARY, init: bearer },
    { kind: 'setcred', change: { euid: 0 } },
    { kind: 'fetch', url: ORDINARY, init: bearer },
  ]);
  assert.deepEqual(answers, ['200 filled', 0, cone.uid, '200 filled', 0, '200 filled']);
  assert.deepEqual(
    asked.map(({ caller }) => [caller.uid, caller.gid, caller.groups]),
    [
      [0, 0, asked[0].caller.groups],
      [cone.uid, cone.gid, [cone.gid]],
      [0, cone.gid, [cone.gid]],
    ]
  );
  assert.equal(new Set(asked.map(({ caller }) => caller.pid)).size, 1);
});

test('a request whose process exited while it waited is refused: no hook call and nothing at the receiver', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const asked = [];
  const { kernel } = await booted(t, {
    network: { transport },
    sealed: { request: noRequest, fetch: recordingHook(asked) },
  });
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  globalThis[SYSCALL_HOOK] = async ({ pid, op }) => {
    if (op !== 'net-request' && op !== 'net-open') return;
    held.resolve(pid);
    await release.promise;
  };
  t.after(() => {
    delete globalThis[SYSCALL_HOOK];
    release.resolve();
  });
  const client = await attachKernel(await kernel.connect());
  t.after(() => client.close());
  const running = kernel.run(
    ['fillprobe', JSON.stringify([{ kind: 'fetch', url: ORDINARY, init: bearer }])],
    { cwd: '/' }
  );
  await client.kill(await held.promise, 'SIGKILL');
  release.resolve();
  assert.equal((await running).signal, 'SIGKILL');
  delete globalThis[SYSCALL_HOOK];
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(asked.length, 0);
  assert.equal(seen.length, 0);
  assert.equal(transport.calls.length, 0);
});

for (const [name, turns] of [
  ['a proxied request', [{ send: get(ORDINARY), until: ENDED }]],
  [
    'a request in a CONNECT tunnel',
    [
      { send: 'CONNECT fake.test:80 HTTP/1.1\r\nHost: fake.test:80\r\n\r\n', until: HEAD_ENDED },
      { send: get('/ordinary'), until: ENDED },
    ],
  ],
]) {
  test(`${name} keeps the stamp from connect after the process changes its credentials`, async (t) => {
    const { port } = await receiver(t);
    const asked = [];
    const { kernel, probe } = await booted(t, {
      network: { transport: wired(port) },
      sealed: { request: noRequest, fetch: recordingHook(asked) },
    });
    const cone = await coneIds(kernel);
    const change = { euid: cone.uid };
    const [held, euid] = await probe([
      { kind: 'socket', change, restore: { euid: 0 }, turns },
      { kind: 'setcred', change },
      { kind: 'socket', turns },
    ]);
    assert.match(held.at(-1), /^HTTP\/1\.1 200 /);
    assert.equal(euid, cone.uid);
    assert.equal(asked.length, 2);
    assert.equal(asked[0].caller.uid, 0);
    assert.equal(asked[1].caller.uid, cone.uid);
  });
}

test('curl through the proxy and through CONNECT is stamped with the user of each run, and a fresh process has its own stamp', async (t) => {
  const { port } = await receiver(t);
  const asked = [];
  const { kernel, curl } = await booted(
    t,
    {
      network: { transport: wired(port) },
      sealed: { request: noRequest, fetch: recordingHook(asked) },
    },
    CURL
  );
  const cone = await coneIds(kernel);
  const args = `-H "Authorization: Bearer ${PH}"`;
  for (const url of ['http://fake.test/plain', ORDINARY]) {
    assert.equal((await curl(`${args} ${url}`)).stdout, 'filled 200');
    assert.equal((await curl(`${args} ${url}`, { user: 'cone' })).stdout, 'filled 200');
  }
  assert.deepEqual(
    asked.map(({ caller }) => caller.uid),
    [0, cone.uid, 0, cone.uid]
  );
  assert.equal(new Set(asked.map(({ caller }) => caller.pid)).size, 4);
});

test('a hook that changes what it was given in place changes nothing the kernel keeps or sends', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const asked = [];
  const fetch = async (req) => {
    asked.push(structuredClone({ caller: req.caller, url: req.url, headers: req.headers }));
    req.caller.uid = 4242;
    req.caller.groups.push(4242);
    req.caller.users = 'off';
    req.url = 'https://elsewhere.test/';
    req.method = 'DELETE';
    req.headers[0][1] = 'changed';
    req.headers.push(['x-added', 'yes']);
    return scrubbed('filled');
  };
  const { kernel, probe } = await booted(t, {
    network: { transport },
    sealed: { request: noRequest, fetch },
  });
  const cone = await coneIds(kernel);
  const [turns] = await probe(
    [
      {
        kind: 'socket',
        turns: [
          { send: get(ORDINARY), until: ENDED },
          { send: get(ORDINARY), until: ENDED },
          { send: get('http://fake.test/plain', 'ordinary'), until: ENDED },
        ],
      },
    ],
    { user: 'cone' }
  );
  assert.deepEqual(
    turns.map((text) => /^HTTP\/1\.1 200 /.test(text)),
    [true, true, true]
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, 'Bearer ordinary');
  assert.equal(seen[0].headers['x-added'], undefined);
  assert.equal(transport.calls[0].stamp.uid, cone.uid);

  await probe([{ kind: 'fetch', url: ORDINARY, init: bearer }], { user: 'cone' });
  await probe([{ kind: 'fetch', url: ORDINARY, init: bearer }]);
  assert.equal(asked.length, 4);
  const [first, second, third, fourth] = asked;
  assert.deepEqual(second, first);
  assert.equal(first.url, ORDINARY);
  assert.ok(first.headers.some(([, value]) => value === `Bearer ${PH}`));
  assert.equal(first.caller.uid, cone.uid);
  assert.deepEqual(first.caller.groups.includes(4242), false);
  assert.equal(first.caller.users, 'enforce');
  assert.equal(third.caller.uid, cone.uid);
  assert.notEqual(third.caller.pid, first.caller.pid);
  assert.equal(third.headers.at(-1)[0] === 'x-added', false);
  assert.equal(fourth.caller.uid, 0);
  assert.notEqual(fourth.caller.pid, third.caller.pid);
});

function relayed(fetch) {
  const answerer = sealedAnswerer({ postMessage() {} }, undefined, fetch);
  const asker = sealedAsker({ postMessage: (message) => answerer.handle(message) });
  return { hook: asker.fetch, answerer };
}

function pulling(size, count, produced) {
  return (async function* () {
    for (let i = 0; i < count; i++) {
      produced.n++;
      yield new Uint8Array(size).fill(i + 1);
    }
  })();
}

for (const [where, wrap] of [
  ['in process', (fetch) => fetch],
  ['through the relay', (fetch) => relayed(fetch).hook],
]) {
  test(`a streaming upload reaches the hook chunk by chunk with backpressure, ${where}`, async (t) => {
    const { port } = await receiver(t);
    const transport = wired(port, { streamingBodies: true, maxRequestBody: 1 << 24 });
    const pace = Promise.withResolvers();
    const got = [];
    const fetch = async (req) => {
      assert.equal(req.body, undefined);
      const reader = req.bodyStream[Symbol.asyncIterator]();
      got.push(await reader.next());
      await pace.promise;
      for (;;) {
        const next = await reader.next();
        if (next.done) break;
        got.push(next);
      }
      return scrubbed(`took ${got.reduce((n, { value }) => n + value.byteLength, 0)}`);
    };
    const { probe } = await booted(t, {
      network: { transport },
      sealed: { request: noRequest, fetch: wrap(fetch) },
    });
    const running = probe([
      { kind: 'upload', url: ORDINARY, init: bearer, chunks: 64, size: 65536 },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(got.length, 1);
    pace.resolve();
    assert.deepEqual(await running, [`200 took ${64 * 65536}`]);
    assert.equal(got.length, 64);
    assert.equal(got.at(-1).value[0], 64);
    assert.equal(transport.calls.length, 0);
  });

  test(`a streaming response reaches the program with backpressure and its cancel reaches the hook, ${where}`, async (t) => {
    const { port } = await receiver(t);
    const produced = { n: 0 };
    const cancelled = Promise.withResolvers();
    const fetch = async () => ({
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/octet-stream']],
      body: pulling(65536, 4096, produced),
      cancel: async () => cancelled.resolve(),
    });
    const { probe } = await booted(t, {
      network: { transport: wired(port) },
      sealed: { request: noRequest, fetch: wrap(fetch) },
    });
    const [answer] = await probe([{ kind: 'firstChunk', url: ORDINARY, init: bearer }]);
    assert.ok(answer.startsWith('200 '));
    await cancelled.promise;
    assert.ok(produced.n < 64, `${produced.n} chunks were pulled`);
  });

  test(`a body that fails after the head reaches the program as an error and sends nothing raw, ${where}`, async (t) => {
    const { seen, port } = await receiver(t);
    const fetch = async () => ({
      ...scrubbed(''),
      body: (async function* () {
        yield new TextEncoder().encode('partial');
        throw new Error('the upstream broke');
      })(),
    });
    const { probe } = await booted(t, {
      network: { transport: wired(port) },
      sealed: { request: noRequest, fetch: wrap(fetch) },
    });
    const [answer] = await probe([{ kind: 'fetch', url: ORDINARY, init: bearer }]);
    assert.match(answer, /^error /);
    assert.equal(seen.length, 0);
  });
}

test('through the relay an abort cancels the hook and its response, and closing the page side refuses', async (t) => {
  const { seen, port } = await receiver(t);
  const stopped = Promise.withResolvers();
  const fetch = (_, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        stopped.resolve(signal.reason);
        reject(new Error('stopped'));
      });
    });
  const { hook, answerer } = relayed(fetch);
  const transport = wired(port);
  const { probe } = await booted(t, {
    network: { transport },
    sealed: { request: noRequest, fetch: hook },
  });
  const [aborted] = await probe([{ kind: 'abort', url: ORDINARY, init: bearer }]);
  assert.match(aborted, /^error /);
  await stopped.promise;

  const pending = Promise.withResolvers();
  const stalled = relayed(() => {
    pending.resolve();
    return new Promise(() => undefined);
  });
  const second = await booted(t, {
    network: { transport },
    sealed: { request: noRequest, fetch: stalled.hook },
  });
  const running = second.probe([{ kind: 'fetch', url: ORDINARY, init: bearer }]);
  await pending.promise;
  stalled.answerer.close();
  const [gone] = await running;
  assert.match(gone, /^error EACCES /);
  assert.match(gone, UNFINISHED);
  answerer.close();
  assert.equal(seen.length, 0);
  assert.equal(transport.calls.length, 0);
});

test('through the relay a hook error, a bad reply and redirect hops are refusals, and a request without a hook says so', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const answers = [
    [
      async () => {
        throw new Error('no rule');
      },
      /no rule/,
    ],
    [async () => ({ status: 'x' }), /not a scrubbed response/],
    [async () => ({ ...scrubbed('x'), redirects: [] }), /not a scrubbed response/],
    [undefined, /no vault is connected/],
  ];
  for (const [fetch, reason] of answers) {
    const { hook } = relayed(fetch);
    const { probe } = await booted(t, {
      network: { transport },
      sealed: { request: noRequest, fetch: hook },
    });
    const [answer] = await probe([{ kind: 'fetch', url: ORDINARY, init: bearer }]);
    assert.match(answer, /^error EACCES /);
    assert.match(answer, UNFINISHED);
    assert.match(answer, reason);
  }
  assert.equal(seen.length, 0);
  assert.equal(transport.calls.length, 0);
});

test('setPlaceholders adds what the syntax misses and an empty list leaves the syntax on; a client has no setter', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const { kernel, curl, probe } = await booted(t, { network: { transport } }, CURL);
  const custom = 'vault_token_not_of_the_syntax';
  const plain = await probe([
    { kind: 'fetch', url: ORDINARY, init: { headers: { 'x-api-key': custom } } },
  ]);
  assert.deepEqual(plain, ['200 delivered']);

  await kernel.sealed.setPlaceholders([custom]);
  const carriers = [
    { kind: 'fetch', url: `https://fake.test/?k=${custom}` },
    { kind: 'fetch', url: ORDINARY, init: { headers: { 'x-api-key': custom } } },
    {
      kind: 'fetch',
      url: ORDINARY,
      init: {
        headers: { authorization: `Basic ${Buffer.from(`u:${custom}`).toString('base64')}` },
      },
    },
  ];
  for (const answer of await probe(carriers)) assert.match(answer, REFUSED);
  assert.match((await curl(`-u 'user:${custom}' ${ORDINARY}`)).stdout, REFUSED);

  await kernel.sealed.setPlaceholders([]);
  assert.deepEqual(
    await probe([{ kind: 'fetch', url: ORDINARY, init: { headers: { 'x-api-key': custom } } }]),
    ['200 delivered']
  );
  assert.match((await probe([{ kind: 'fetch', url: ORDINARY, init: bearer }]))[0], REFUSED);

  for (const bad of ['x', [''], [1], undefined]) {
    await assert.rejects(kernel.sealed.setPlaceholders(bad), (e) => e.code === 'EINVAL');
  }

  const client = await attachKernel(await kernel.connect());
  t.after(() => client.close());
  assert.equal(client.sealed, undefined);
  assert.equal(client.setPlaceholders, undefined);
  assert.equal(client.attest, undefined);
  assert.equal(seen.length, 2);
});

test('a placeholder from the list goes to the fetch hook as a canonical one does', async (t) => {
  const { port } = await receiver(t);
  const transport = wired(port);
  const asked = [];
  const fetch = async (req) => {
    asked.push(req.url);
    return scrubbed('filled');
  };
  const { kernel, probe } = await booted(t, {
    network: { transport },
    sealed: { request: noRequest, fetch },
  });
  await kernel.sealed.setPlaceholders(['vault_token_listed']);
  const url = 'https://fake.test/?k=vault_token_listed';
  assert.deepEqual(await probe([{ kind: 'fetch', url }]), ['200 filled']);
  assert.deepEqual(asked, [url]);
  assert.equal(transport.calls.length, 0);
});

for (const form of ['a bare function', 'the object form']) {
  test(`${form} still serves /dev/sealed`, async (t) => {
    const calls = [];
    const request = async (req) => {
      calls.push(req);
      return { v: 1, ok: true };
    };
    const { kernel } = await booted(
      t,
      { sealed: form === 'a bare function' ? request : { request } },
      ['wasm-bash']
    );
    const { stdout } = await kernel.run(
      [
        'bash',
        '-c',
        `exec 3<>/dev/sealed; printf %s '{"v":1,"op":"status"}' >&3; read -r reply <&3; printf %s "$reply"`,
      ],
      { cwd: '/' }
    );
    assert.deepEqual(JSON.parse(stdout), { v: 1, ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, 'status');
    assert.equal(calls[0].caller.uid, 0);
  });
}

test('a sealed option that is neither a function nor { request, fetch? } rejects', async () => {
  for (const sealed of [
    { fetch: async () => undefined },
    { request: 1 },
    { request() {}, fetch: 1 },
  ]) {
    await assert.rejects(createNodeKernel({ sealed }), /sealed takes a function/);
  }
});

async function attestor(t, users = 'enforce') {
  const { kernel, probe } = await booted(t, { users });
  await kernel.writeFile('/etc/slicc/policy.toml', 'rule = 1');
  return { kernel, probe };
}

test('attest with absent allow answers a tombstone for a missing file under trusted parents', async (t) => {
  const { kernel } = await attestor(t);
  const present = await kernel.attest('/etc/slicc/policy.toml', { absent: 'allow' });
  assert.equal(new TextDecoder().decode(present.bytes), 'rule = 1');
  assert.equal(present.absent, undefined);

  const gone = await kernel.attest('/etc/slicc/../slicc/gone.toml', { absent: 'allow' });
  assert.deepEqual(Object.keys(gone).sort(), ['absent', 'onRootFs', 'parents', 'path', 'users']);
  assert.equal(gone.path, '/etc/slicc/gone.toml');
  assert.equal(gone.absent, true);
  assert.equal(gone.users, 'enforce');
  assert.equal(gone.onRootFs, true);
  assert.deepEqual(
    gone.parents.map((p) => p.path),
    ['/', '/etc', '/etc/slicc']
  );
  assert.deepEqual(
    gone.parents.map((p) => p.uid),
    [0, 0, 0]
  );
});

test('attest without the option still rejects a missing file', async (t) => {
  const { kernel } = await attestor(t);
  await assert.rejects(kernel.attest('/etc/slicc/gone.toml'), (e) => e.code === 'ENOENT');
});

test('attest with absent allow rejects a missing ancestor, a symlink, a directory, an untrusted parent and a mount', async (t) => {
  const { kernel, probe } = await attestor(t);
  const allow = { absent: 'allow' };
  await probe([{ kind: 'setup' }]);
  await kernel.users.add({ name: 'cone' });
  const refusals = [
    ['/etc/missing/gone.toml', 'ENOENT'],
    ['/etc/linked/gone.toml', 'EACCES'],
    ['/etc/slicc/dangling', 'EACCES'],
    ['/etc/slicc', 'EISDIR'],
    ['/etc/open/gone.toml', 'EACCES'],
    ['/home/cone/gone.toml', 'EACCES'],
    ['/etc/slicc/file/gone.toml', 'ENOTDIR'],
    ['/tmp/gone.toml', 'EACCES'],
  ];
  for (const [path, code] of refusals) {
    await assert.rejects(kernel.attest(path, allow), (e) => e.code === code, path);
  }
  await assert.rejects(kernel.attest('relative', allow), (e) => e.code === 'EINVAL');
  await assert.rejects(
    kernel.attest('/etc/slicc/gone.toml', { absent: 'yes' }),
    (e) => e.code === 'EINVAL'
  );
});

test('attest is on the Node host, and users off skips the parent check as for a file', async (t) => {
  const { kernel } = await attestor(t, 'off');
  const gone = await kernel.attest('/etc/slicc/gone.toml', { absent: 'allow' });
  assert.equal(gone.absent, true);
  assert.equal(gone.users, 'off');
});
