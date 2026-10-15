import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { fakeUplink } from '../../dist/testing.js';

const fixture = new URL('./fixtures/udptest/', import.meta.url);
const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 60_000 };

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

async function kernelWith(t, options = {}) {
  const kernel = await createNodeKernel({ users: 'off', ...options });
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/udptest.wasm']) {
    await kernel.writeFile(`/node_modules/udptest/${file}`, await readFile(new URL(file, fixture)));
  }
  return kernel;
}

const run = async (kernel, ...args) =>
  (await kernel.run(['udptest', ...args], { cwd: '/' })).stdout;

test('two processes exchange datagrams over the kernel loopback', TIMEOUT, async (t) => {
  const kernel = await kernelWith(t);
  await install(kernel, 'wasm-bash');
  const got = await kernel.run(
    [
      'bash',
      '-c',
      'udptest serve 5353 2 & udptest client 127.0.0.1 5353 hello; udptest client 127.0.0.1 5353 again; wait',
    ],
    { cwd: '/' }
  );
  const lines = got.stdout.trim().split('\n').sort();
  assert.equal(lines.length, 3, got.stdout + got.stderr);
  assert.match(lines[0], /^reply AGAIN from 127\.0\.0\.1:5353$/);
  assert.match(lines[1], /^reply HELLO from 127\.0\.0\.1:5353$/);
  assert.equal(lines[2], 'served 2');
});

test(
  'one datagram per read, truncation, peek, size limits, bind rules and options',
  TIMEOUT,
  async (t) => {
    const kernel = await kernelWith(t);
    assert.equal(
      await run(kernel, 'datagrams'),
      [
        'trunc 4 0123',
        'peek 6 second',
        'then 6 second',
        'empty EAGAIN',
        'big EMSGSIZE',
        'max ok',
        'nodest EDESTADDRREQ',
        'inuse EADDRINUSE',
        'farbind EADDRNOTAVAIL',
        'broadcast EOPNOTSUPP',
        'type SOCK_DGRAM',
        '',
      ].join('\n')
    );
  }
);

test(
  'a connected socket gets ECONNREFUSED once after sending to a closed port; an unconnected one does not',
  TIMEOUT,
  async (t) => {
    const kernel = await kernelWith(t);
    assert.equal(
      await run(kernel, 'refused'),
      'first ok\nnext ECONNREFUSED\nafter ok\nunconnected ok\n'
    );
  }
);

test(
  'link-local, the host, unrouted, multicast and broadcast addresses are unreachable',
  TIMEOUT,
  async (t) => {
    const uplink = fakeUplink({ routes: { prefixes: [], exit: true }, datagrams: {} });
    const kernel = await kernelWith(t, { network: { uplink } });
    assert.equal(
      await run(kernel, 'unreachable'),
      [
        '169.254.169.254 ENETUNREACH',
        '10.0.2.2 ENETUNREACH',
        '192.0.2.1 ok',
        '224.0.0.1 ENETUNREACH',
        '255.255.255.255 ENETUNREACH',
        'connect ENETUNREACH',
        'unix EPROTONOSUPPORT',
        '',
      ].join('\n')
    );
    assert.deepEqual(
      uplink.sent.map(({ host, port }) => `${host}:${port}`),
      ['192.0.2.1:53']
    );
    const bare = await kernelWith(t);
    assert.match(
      await run(bare, 'unreachable'),
      /^169\.254\.169\.254 ENETUNREACH\n10\.0\.2\.2 ENETUNREACH\n192\.0\.2\.1 ENETUNREACH\n/
    );
  }
);

test(
  'a datagram to a routed address goes through uplink.udp and its answer comes back',
  TIMEOUT,
  async (t) => {
    const uplink = fakeUplink({
      routes: { prefixes: ['100.64.0.0/10'], exit: false },
      datagrams: { '100.64.0.53:53': (bytes) => bytes.slice().reverse() },
    });
    const kernel = await kernelWith(t, { network: { uplink } });
    assert.equal(
      await run(kernel, 'client', '100.64.0.53', '53', 'hello'),
      'reply olleh from 100.64.0.53:53\n'
    );
    assert.deepEqual(
      uplink.sent.map(
        ({ host, port, bytes }) => `${host}:${port} ${new TextDecoder().decode(bytes)}`
      ),
      ['100.64.0.53:53 hello']
    );
  }
);

test(
  "an uplink's unreachable report fails a connected socket once and is dropped for an unconnected one",
  TIMEOUT,
  async (t) => {
    const uplink = fakeUplink({
      routes: { prefixes: ['100.64.0.0/10'], exit: false },
      datagrams: { '100.64.0.9:123': () => ({ error: 'EACCES' }) },
    });
    const kernel = await kernelWith(t, { network: { uplink } });
    assert.equal(
      await run(kernel, 'unreached', '100.64.0.9', '123'),
      [
        'connected send ok',
        'connected next EACCES',
        'connected after ok',
        'unconnected send ok',
        'unconnected next EAGAIN',
        '',
      ].join('\n')
    );
  }
);

test('without traits.udp a routed datagram is ENETUNREACH', TIMEOUT, async (t) => {
  const uplink = fakeUplink({ routes: { prefixes: ['100.64.0.0/10'], exit: false } });
  const kernel = await kernelWith(t, { network: { uplink } });
  assert.equal(await run(kernel, 'client', '100.64.0.53', '53', 'hello'), 'sendto ENETUNREACH\n');
});
