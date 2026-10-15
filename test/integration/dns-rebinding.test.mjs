import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import dns from 'node:dns';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createNodeKernel, nodeTransport } from '../../dist/node.js';

const NAME = 'rebind.slicc.test';
const OTHER = 'proxied.slicc.test';
const PUBLIC = '93.184.216.34';

function rebind(names, publicAddress) {
  const dns = process.getBuiltinModule('node:dns');
  const { syncBuiltinESMExports } = process.getBuiltinModule('node:module');
  const promised = dns.promises.lookup;
  const called = dns.lookup;
  dns.promises.lookup = async (host, options) => {
    if (!names.includes(host)) return promised(host, options);
    const entry = { address: publicAddress, family: 4 };
    return options && typeof options === 'object' && options.all ? [entry] : entry;
  };
  dns.lookup = function (host, options, callback) {
    if (!names.includes(host)) return called.call(this, host, options, callback);
    const done = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options !== null && options.all;
    process.nextTick(() =>
      all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)
    );
    return {};
  };
  syncBuiltinESMExports();
}

rebind([NAME, OTHER], PUBLIC);

test('the pre-check resolves the name to a public address, the connect to 127.0.0.1', async () => {
  const { lookup } = await import('node:dns/promises');
  assert.deepEqual(await lookup(NAME, { all: true }), [{ address: PUBLIC, family: 4 }]);
  const connected = await new Promise((resolve) =>
    dns.lookup(NAME, { all: true }, (_e, a) => resolve(a))
  );
  assert.deepEqual(connected, [{ address: '127.0.0.1', family: 4 }]);
});

const PROBE_PACKAGE = JSON.stringify({
  name: 'netprobe',
  slicc: { commands: { netprobe: { abi: 'js', module: 'bin/netprobe.mjs' } } },
});

const PROBE = `export default async function main(ctx) {
  const why = (err) => 'error ' + (err.cause?.code ?? err.code ?? err.message) + ' ' + (err.cause?.message ?? err.message);
  const [mode, url] = ctx.argv.slice(1);
  if (mode === 'fetch') {
    const got = await ctx.fetch(url).then(async (r) => r.status + ' ' + (await r.text()), why);
    await ctx.write(1, got);
  } else {
    const got = await ctx.websocket(url).then((s) => { s.close(); return 'open'; }, why);
    await ctx.write(1, got);
  }
}
`;

async function hostServer(t, handler) {
  let hits = 0;
  let upgrades = 0;
  const server = createServer((req, res) => {
    hits++;
    if (handler) return handler(req, res);
    res.end('host secret\n');
  });
  server.on('upgrade', (_req, socket) => {
    upgrades++;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { server, port: server.address().port, hits: () => hits, upgrades: () => upgrades };
}

async function kernelWith(t, transport) {
  const kernel = await createNodeKernel({ users: 'off', network: { transport } });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/netprobe/package.json', PROBE_PACKAGE);
  await kernel.writeFile('/node_modules/netprobe/bin/netprobe.mjs', PROBE);
  return async (mode, url) => (await kernel.run(['netprobe', mode, url], { cwd: '/' })).stdout;
}

const REFUSED =
  /^403 nodeTransport refuses the host's loopback 127\.0\.0\.1:\d+ \(see nodeTransport\({ hostLoopback }\)\)$/;

function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('a name that passes the pre-check but connects to the host loopback is refused at connect, 0 requests reach the host', async (t) => {
  const host = await hostServer(t);
  const probe = await kernelWith(t, nodeTransport());
  assert.match(await probe('fetch', `http://${NAME}:${host.port}/`), REFUSED);
  assert.equal(host.hits(), 0);
});

test('a redirect hop to a rebinding name is refused at connect, after the first hop is allowed', async (t) => {
  const target = await hostServer(t);
  const first = await hostServer(t, (_req, res) => {
    res.writeHead(302, { location: `http://${NAME}:${target.port}/` });
    res.end();
  });
  const probe = await kernelWith(t, nodeTransport({ hostLoopback: [first.port] }));
  assert.match(await probe('fetch', `http://host.slicc.internal:${first.port}/`), REFUSED);
  assert.equal(first.hits(), 1);
  assert.equal(target.hits(), 0);
});

test('a WebSocket to a rebinding name is refused at connect, 0 upgrades reach the host', async (t) => {
  const host = await hostServer(t);
  const probe = await kernelWith(t, nodeTransport());
  assert.match(await probe('websocket', `ws://${NAME}:${host.port}/`), /^error EACCES /);
  assert.equal(host.upgrades(), 0);
});

test('an allowed loopback port still connects', async (t) => {
  const host = await hostServer(t);
  const probe = await kernelWith(t, nodeTransport({ hostLoopback: [host.port] }));
  assert.equal(await probe('fetch', `http://${NAME}:${host.port}/`), '200 host secret\n');
  assert.equal(host.hits(), 1);
});

test('HTTP_PROXY without NODE_USE_ENV_PROXY exempts nothing', async (t) => {
  const host = await hostServer(t);
  withEnv(t, { HTTP_PROXY: `http://127.0.0.1:${host.port}`, NODE_USE_ENV_PROXY: undefined });
  const probe = await kernelWith(t, nodeTransport());
  assert.match(await probe('fetch', `http://${NAME}:${host.port}/`), REFUSED);
  assert.equal(host.hits(), 0);
});

test('a name rebound to the proxy address is not exempt as the proxy', async (t) => {
  const host = await hostServer(t);
  withEnv(t, { HTTP_PROXY: `http://127.0.0.1:${host.port}`, NODE_USE_ENV_PROXY: '1' });
  const probe = await kernelWith(t, nodeTransport());
  assert.match(await probe('fetch', `http://${NAME}:${host.port}/`), REFUSED);
  assert.equal(host.hits(), 0);
});

async function client(dist, urls) {
  const { nodeTransport } = await import(dist);
  const transport = nodeTransport();
  const why = (err) => `error ${err.code} ${err.message}`;
  const open = (url) =>
    transport
      .fetch({ url, method: 'GET', headers: [], signal: AbortSignal.timeout(10000) })
      .catch((err) => err);
  const read = async (response) => {
    if (response instanceof Error) return why(response);
    let text = '';
    for await (const chunk of response.body) text += new TextDecoder().decode(chunk);
    return `${response.status} ${text}`;
  };
  const opened = [];
  for (const url of urls) opened.push(await open(url));
  const results = [];
  for (const response of opened) results.push(await read(response));
  process.stdout.write(JSON.stringify(results));
}

async function throughProxy(proxyPort, urls, env = {}) {
  const dist = new URL('../../dist/node.js', import.meta.url).href;
  const code = `(${rebind})(${JSON.stringify([NAME, OTHER])}, ${JSON.stringify(PUBLIC)});
await (${client})(${JSON.stringify(dist)}, ${JSON.stringify(urls)});`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', code],
    {
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: '',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_NO_WARNINGS: '1',
        ...env,
      },
    }
  );
  return JSON.parse(stdout);
}

async function forwardingProxy(t) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`GET ${req.url}`);
    const url = new URL(req.url);
    const upstream = httpRequest(
      { host: '127.0.0.1', port: url.port, path: url.pathname, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      }
    );
    upstream.end();
  });
  server.on('connect', (req, socket, head) => {
    seen.push(`CONNECT ${req.url}`);
    const upstream = tcp(Number(req.url.split(':').pop()), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { port: server.address().port, seen };
}

async function tlsServer(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rebind-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    `/CN=${NAME}`,
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
  ]);
  let hits = 0;
  const server = createHttpsServer(
    { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
    (_req, res) => {
      hits++;
      res.end('tls secret\n');
    }
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { port: server.address().port, hits: () => hits };
}

test('http and https through a loopback env proxy reach the target through the proxy', async (t) => {
  const target = await hostServer(t);
  const secure = await tlsServer(t);
  const proxy = await forwardingProxy(t);
  const results = await throughProxy(proxy.port, [
    `http://${NAME}:${target.port}/`,
    `https://${NAME}:${secure.port}/`,
    `http://${NAME}:${target.port}/again`,
  ]);
  assert.deepEqual(results, ['200 host secret\n', '200 tls secret\n', '200 host secret\n']);
  assert.equal(target.hits(), 2);
  assert.equal(secure.hits(), 1);
  assert.ok(proxy.seen.length >= 2, proxy.seen.join(', '));
  assert.ok(
    proxy.seen.every((line) => line.includes(NAME)),
    proxy.seen.join(', ')
  );
});

test('a direct rebinding to the proxy address is refused while a proxied connection to it is live', async (t) => {
  const target = await hostServer(t);
  const proxy = await forwardingProxy(t);
  const results = await throughProxy(
    proxy.port,
    [`http://${OTHER}:${target.port}/`, `http://${NAME}:${proxy.port}/`],
    { NO_PROXY: NAME }
  );
  assert.equal(results[0], '200 host secret\n');
  assert.match(
    results[1],
    /^error EACCES nodeTransport refuses the host's loopback 127\.0\.0\.1:\d+ /
  );
  assert.deepEqual(
    proxy.seen.filter((line) => line.includes(NAME)),
    []
  );
});

test('a NO_PROXY host is checked as a direct connection', async (t) => {
  const target = await hostServer(t);
  const proxy = await forwardingProxy(t);
  const results = await throughProxy(proxy.port, [`http://${NAME}:${target.port}/`], {
    NO_PROXY: NAME,
  });
  assert.match(
    results[0],
    /^error EACCES nodeTransport refuses the host's loopback 127\.0\.0\.1:\d+ /
  );
  assert.equal(target.hits(), 0);
  assert.deepEqual(proxy.seen, []);
});
