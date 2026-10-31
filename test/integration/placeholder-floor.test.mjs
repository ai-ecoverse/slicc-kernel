import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel, nodeTransport } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const PH = 'fnox_proxy_0123456789abcdef01234567';
const PH2 = 'fnox_proxy_89abcdef0123456789abcdef';
const REFUSED = /refused: this request has a sealed placeholder/;
const encoded = PH.replace('f', '%66').replaceAll('_', '%5F');
const twice = PH.replace('f', '%2566');
const base64 = (text) => Buffer.from(text, 'latin1').toString('base64');

const PACKAGE = JSON.stringify({
  name: 'floorprobe',
  slicc: { commands: { floorprobe: { abi: 'js', module: 'bin/floorprobe.mjs' } } },
});

const PROGRAM = `const why = (e) => 'error ' + (e.cause?.code ?? e.code) + ' ' + (e.cause?.message ?? e.message);
const decoder = new TextDecoder();
const steps = {
  fetch: ({ url, init }, ctx) =>
    ctx.fetch(url, init).then(async (r) => r.status + ' ' + (await r.text()), why),
  stream: ({ url, init }, ctx) => {
    const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8)); c.close(); } });
    return ctx.fetch(url, { ...init, method: 'POST', body, duplex: 'half' }).then((r) => String(r.status), why);
  },
  websocket: ({ url, init }, ctx) =>
    ctx.websocket(url, init).then((s) => { s.close(); return 'open'; }, why),
  proxy: async ({ head }, ctx) => {
    const conn = await ctx.net.connect({ host: '127.0.0.1', port: 3128 });
    const writer = conn.writable.getWriter();
    await writer.write(new TextEncoder().encode(head));
    const reader = conn.readable.getReader();
    let text = '';
    while (!text.includes('\\r\\n\\r\\n') || !/realm proxy|Switching/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await conn.close();
    return text.replaceAll('\\r\\n', ' ');
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

function wired(port) {
  const wire = nodeTransport({ hostLoopback: [port] });
  const calls = [];
  return {
    calls,
    traits: wire.traits,
    fetch(request, owner) {
      calls.push({ url: request.url, headers: request.headers, owner });
      const { pathname, search } = new URL(request.url);
      const url = `http://127.0.0.1:${port}${pathname}${search}`;
      return wire.fetch({ ...request, url }, owner);
    },
  };
}

function reply(status, text = '') {
  return {
    url: 'https://raw.test/b',
    status,
    statusText: '',
    headers: [['content-type', 'text/plain']],
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
    cancel: async () => undefined,
  };
}

function recording(extra = {}) {
  const calls = [];
  const sockets = [];
  return {
    calls,
    sockets,
    traits: {
      manualRedirects: true,
      encodedBodies: false,
      maxRequestBody: 1 << 20,
      websocket: true,
      ...extra,
    },
    async fetch(request, ...rest) {
      calls.push({ url: request.url, headers: request.headers, rest });
      return reply(200, 'delivered');
    },
    async websocket(request) {
      sockets.push({ url: request.url, headers: request.headers, protocols: request.protocols });
      const { promise, resolve } = Promise.withResolvers();
      return {
        protocol: '',
        buffered: 0,
        send() {},
        messages: {
          [Symbol.asyncIterator]: () => ({
            next: () => promise.then(() => ({ done: true, value: undefined })),
          }),
        },
        close: (code = 1000, reason = '') => resolve({ code, reason, wasClean: true }),
        closed: promise,
      };
    },
  };
}

function redirecting() {
  const hop = {
    status: 302,
    url: 'https://raw.test/a',
    headers: [['location', 'https://raw.test/b']],
  };
  return Object.assign(recording({ manualRedirects: false, redirectHops: true }), {
    async fetch(request, ...rest) {
      this.calls.push({ url: request.url, rest });
      if (new URL(request.url).pathname !== '/a') return reply(200, 'direct');
      return { ...reply(200, 'final'), redirected: true, redirects: [hop] };
    },
  });
}

async function booted(t, options, packages = []) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  for (const name of packages) await install(kernel, name);
  await kernel.writeFile('/node_modules/floorprobe/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/floorprobe/bin/floorprobe.mjs', PROGRAM);
  return {
    kernel,
    probe: async (...steps) => {
      const { stdout, stderr } = await kernel.run(['floorprobe', JSON.stringify(steps)], {
        cwd: '/',
      });
      assert.equal(stderr, '');
      return JSON.parse(stdout);
    },
  };
}

const CURL = ['wasm-bash', 'wasm-curl', 'wasm-tls-engine'];

function curlOn(kernel) {
  return (args, env = {}) =>
    kernel.run(['bash', '-c', `curl -sS -w ' %{http_code}' ${args}`], { cwd: '/', env });
}

test('curl with a placeholder in Authorization is refused locally while a sealed hook is installed: 403, and the receiver sees nothing', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const sealedCalls = [];
  const { kernel } = await booted(
    t,
    {
      users: 'enforce',
      sealed: async (request) => {
        sealedCalls.push(request.op);
        return { v: 1, error: { code: 'EACCES', message: 'no fill' } };
      },
      network: { transport },
    },
    CURL
  );
  const curl = curlOn(kernel);
  for (const url of ['https://fake.test/ordinary', `http://host.slicc.internal:${port}/ordinary`]) {
    const { status, stdout } = await curl(`-H "Authorization: Bearer $TOKEN" '${url}'`, {
      TOKEN: PH,
    });
    assert.equal(status, 0);
    assert.match(stdout, REFUSED);
    assert.match(stdout, / 403$/);
  }
  assert.equal(seen.length, 0);
  assert.equal(transport.calls.length, 0);
  assert.deepEqual(sealedCalls, []);
});

const REFUSED_CURLS = [
  ['query', `'https://fake.test/a?key=${PH}'`],
  ['path', `'https://fake.test/${PH}/a'`],
  ['host', `'http://${PH}.fake.test/'`],
  ['user info', `'https://user:${PH}@fake.test/'`],
  ['percent-encoded path', `'https://fake.test/${encoded}'`],
  ['percent-encoded query', `'https://fake.test/a?key=${encoded}'`],
  ['percent-encoded twice', `'https://fake.test/${twice}'`],
  ['header value', `-H 'X-Api-Key: ${PH}' https://fake.test/`],
  ['header name', `-H '${PH}: 1' https://fake.test/`],
  ['Basic user', `-u '${PH}:password' https://fake.test/`],
  ['Basic password', `-u 'user:${PH}' https://fake.test/`],
  ['Basic both', `-u '${PH}:${PH2}' https://fake.test/`],
  [
    'Basic without padding',
    `-H 'Authorization: Basic ${base64(`u:${PH}`).replace(/=+$/, '')}' https://fake.test/`,
  ],
  ['Basic with a stray byte', `-H 'Authorization: Basic !${base64(`u:${PH}`)}' https://fake.test/`],
  ['Basic without a colon', `-H 'Authorization: Basic ${base64(PH)}' https://fake.test/`],
  [
    'Basic that is not UTF-8',
    `-H 'Authorization: Basic ${base64(`\xff\xfe:${PH}`)}' https://fake.test/`,
  ],
  ['a literal in Basic', `-H 'Authorization: Basic ${PH}' https://fake.test/`],
];

for (const users of ['off', 'enforce']) {
  test(`every carrier of a placeholder is refused with no sealed option, users ${users}, and requests without one are delivered unchanged`, async (t) => {
    const { seen, port } = await receiver(t);
    const transport = wired(port);
    const { kernel } = await booted(t, { users, network: { transport } }, CURL);
    const curl = curlOn(kernel);
    for (const [name, args] of REFUSED_CURLS) {
      const { stdout } = await curl(args);
      assert.match(stdout, REFUSED, name);
      assert.match(stdout, / 403$/, name);
    }
    assert.equal(seen.length, 0);
    assert.equal(transport.calls.length, 0);

    const plain = await curl(`-u 'alice:s3cret' 'https://fake.test/plain?a=%66nox'`);
    assert.equal(plain.stdout, 'delivered 200');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/plain?a=%66nox');
    assert.equal(seen[0].headers.authorization, `Basic ${base64('alice:s3cret')}`);

    const body = await curl(`--data '${PH}' https://fake.test/body`);
    assert.equal(body.stdout, 'delivered 200');
    assert.equal(seen[1].body, PH);
  });
}

test('ctx.fetch with a placeholder rejects with EACCES and client.fetch rejects with EACCES and 403, with nothing sent', async (t) => {
  const { seen, port } = await receiver(t);
  const transport = wired(port);
  const { kernel, probe } = await booted(t, { network: { transport } });
  const answers = await probe(
    { kind: 'fetch', url: `https://fake.test/?k=${PH}` },
    { kind: 'fetch', url: `https://fake.test/${encoded}` },
    { kind: 'fetch', url: `https://${PH}.fake.test/` },
    { kind: 'fetch', url: 'https://fake.test/', init: { headers: { 'x-api-key': PH } } },
    { kind: 'fetch', url: 'https://fake.test/', init: { headers: { [PH]: '1' } } },
    {
      kind: 'fetch',
      url: 'https://fake.test/',
      init: { headers: { authorization: `Basic ${base64(`u:${PH}`)}` } },
    },
    { kind: 'stream', url: 'https://fake.test/', init: { headers: { 'x-api-key': PH } } }
  );
  assert.equal(answers.length, 7);
  for (const answer of answers) {
    assert.match(answer, /^error EACCES /);
    assert.match(answer, REFUSED);
  }
  const client = await attachKernel(await kernel.connect());
  t.after(() => client.close());
  for (const [url, headers] of [
    ['https://fake.test/', [['authorization', `Bearer ${PH}`]]],
    [`https://user:${PH}@fake.test/`, []],
  ]) {
    await assert.rejects(client.fetch({ url, method: 'GET', headers }), (e) => {
      assert.equal(e.code, 'EACCES');
      assert.equal(e.status, 403);
      assert.match(e.message, REFUSED);
      return true;
    });
  }
  assert.equal(seen.length, 0);
  assert.equal(transport.calls.length, 0);

  assert.deepEqual(
    await probe({ kind: 'fetch', url: 'https://fake.test/a', init: { headers: { 'x-a': 'b' } } }),
    ['200 delivered']
  );
  const response = await client.fetch({ url: 'https://fake.test/b', method: 'GET', headers: [] });
  assert.equal(response.status, 200);
  await response.cancel();
  assert.deepEqual(
    seen.map((s) => s.url),
    ['/a', '/b']
  );
});

test("a WebSocket handshake with a placeholder is refused before the transport's websocket runs", async (t) => {
  const transport = recording();
  const { kernel, probe } = await booted(t, { users: 'off', network: { transport } });
  const answers = await probe(
    { kind: 'websocket', url: `wss://fake.test/?k=${PH}` },
    { kind: 'websocket', url: `wss://fake.test/${encoded}` },
    { kind: 'websocket', url: 'wss://fake.test/', init: { headers: { 'x-api-key': PH } } },
    {
      kind: 'websocket',
      url: 'wss://fake.test/',
      init: { headers: { authorization: `Basic ${base64(`${PH}:p`)}` } },
    },
    { kind: 'websocket', url: 'wss://fake.test/', init: { protocols: [PH] } }
  );
  assert.equal(answers.length, 5);
  for (const answer of answers) assert.match(answer, /^error EACCES /);
  const upgrade = (target, line = '') =>
    `GET ${target} HTTP/1.1\r\nHost: fake.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
    `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${line}\r\n`;
  const proxied = await probe(
    { kind: 'proxy', head: upgrade(`ws://fake.test/?k=${PH}`) },
    { kind: 'proxy', head: upgrade('ws://fake.test/', `X-Api-Key: ${PH}\r\n`) },
    {
      kind: 'proxy',
      head: upgrade('ws://fake.test/', `Authorization: Basic ${base64(`u:${PH}`)}\r\n`),
    }
  );
  assert.equal(proxied.length, 3);
  for (const answer of proxied) {
    assert.match(answer, /^HTTP\/1\.1 403 /);
    assert.match(answer, REFUSED);
  }
  const client = await attachKernel(await kernel.connect());
  t.after(() => client.close());
  await assert.rejects(
    client.transport.websocket({
      url: `wss://fake.test/?k=${PH}`,
      protocols: [],
      headers: [],
      signal: new AbortController().signal,
    }),
    (e) => e.code === 'EACCES' && e.status === 403
  );
  assert.equal(transport.sockets.length, 0);

  assert.deepEqual(await probe({ kind: 'websocket', url: 'wss://fake.test/' }), ['open']);
  assert.equal(transport.sockets.length, 1);
});

test('a raw transport that reports redirect hops gets the owner, an undefined owner stays undefined, and a held chain still replays', async (t) => {
  const transport = redirecting();
  const { kernel, probe } = await booted(t, { network: { transport } });
  assert.deepEqual(await probe({ kind: 'fetch', url: 'https://raw.test/a' }), ['200 final']);
  assert.equal(transport.calls.length, 1);
  const [owner] = transport.calls[0].rest;
  assert.ok(Number.isInteger(owner) && owner > 0, `owner ${owner}`);

  const client = await attachKernel(await kernel.connect());
  t.after(() => client.close());
  const response = await client.fetch({ url: 'https://raw.test/c', method: 'GET', headers: [] });
  await response.cancel();
  assert.deepEqual(transport.calls.at(-1).rest, [undefined, undefined]);
});

test('a placeholder is refused, not replayed, at the target of a held chain that its Authorization would match', async (t) => {
  const transport = redirecting();
  const { probe } = await booted(t, { network: { transport } });
  const manual = { redirect: 'manual', headers: { authorization: 'Bearer ordinary' } };
  const answers = await probe(
    { kind: 'fetch', url: 'https://raw.test/a', init: manual },
    {
      kind: 'fetch',
      url: 'https://raw.test/b',
      init: { headers: { authorization: `Bearer ${PH}` } },
    },
    {
      kind: 'fetch',
      url: 'https://raw.test/b',
      init: { headers: { authorization: 'Bearer ordinary' } },
    }
  );
  assert.match(answers[0], /^302 /);
  assert.match(answers[1], /^error EACCES /);
  assert.match(answers[1], REFUSED);
  assert.equal(answers[2], '200 final');
  assert.equal(transport.calls.length, 1);
});
