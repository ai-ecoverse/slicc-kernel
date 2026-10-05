import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
const key = 'test-proxy-key';
let proxy;
before(async () => {
  proxy = await fakeProxy({ origin: new URL(chrome.url).origin, key });
});
after(async () => {
  await proxy.close();
  await chrome.close();
});

const withProxy = (t, presented = key) =>
  booted(chrome, t, { proxy: { url: proxy.url, key: presented } });

test('curl reaches https through a CONNECT tunnel and the local proxy', async (t) => {
  const { page, bash } = await withProxy(t);
  proxy.seen.length = 0;

  const { status, stdout, stderr } = await bash('curl -sS -f https://proxy.test/hello');
  assert.equal(stderr, '');
  assert.equal(status, 0);
  assert.equal(stdout, 'hello through the local proxy\n');
  assert.equal(proxy.seen.length, 1);
  assert.equal(proxy.seen[0].url, 'https://proxy.test/hello');
  assert.equal(proxy.seen[0].method, 'GET');
  assert.ok(proxy.seen[0].headers.some(([name]) => name.toLowerCase() === 'user-agent'));
  assert.deepEqual(page.errors, []);
});

test('redirects reach curl unfollowed, with every Set-Cookie', async (t) => {
  const { bash } = await withProxy(t);

  const moved = await bash('curl -sS -i http://proxy.test/moved');
  assert.equal(moved.status, 0);
  assert.match(moved.stdout, /^HTTP\/1\.1 302 Found\r\n/);
  assert.match(moved.stdout, /\r\nlocation: \/hello\r\n/i);

  const cookies = await bash('curl -sS -D - -o /dev/null https://proxy.test/hello');
  assert.deepEqual(cookies.stdout.match(/^set-cookie: .*$/gim), [
    'set-cookie: a=1; Path=/',
    'set-cookie: b=2; Path=/',
  ]);
});

test('a request body reaches the proxy', async (t) => {
  const { bash } = await withProxy(t);
  proxy.seen.length = 0;

  const { status, stdout } = await bash('curl -sS -d hello=world https://proxy.test/echo');
  assert.equal(status, 0);
  assert.equal(stdout, 'echo hello=world');
  assert.equal(proxy.seen[0].method, 'POST');
  assert.equal(proxy.seen[0].body, 'hello=world');
});

test('a wrong key is refused, and curl sees the refusal', async (t) => {
  const { page, bash } = await withProxy(t, 'wrong-key');
  proxy.seen.length = 0;

  const { status, stdout } = await bash('curl -sS -w "%{http_code}" https://proxy.test/hello');
  assert.equal(status, 0);
  assert.match(stdout, /proxy key missing or wrong/);
  assert.match(stdout, /403$/);
  assert.deepEqual(proxy.seen, []);

  const probe = (presented) =>
    page.evaluate((o) => window.probeLocalProxy(o), { url: proxy.url, key: presented });
  assert.equal(await probe('wrong-key'), null);
  assert.deepEqual(await probe(key), {
    rawFetch: 1,
    requestBodyStreaming: false,
    maxRequestBodyBytes: 1024,
  });
});

test('checkLocalProxy tells a ready, refusing and missing proxy apart', async (t) => {
  const { page } = await withProxy(t);
  const check = (url, presented) =>
    page.evaluate((o) => window.checkLocalProxy(o), { url, key: presented });

  assert.deepEqual(await check(proxy.url, key), {
    state: 'ready',
    probe: { rawFetch: 1, requestBodyStreaming: false, maxRequestBodyBytes: 1024 },
  });
  assert.deepEqual(await check(proxy.url, 'wrong-key'), {
    state: 'refused',
    status: 403,
    error: 'proxy key missing or wrong',
  });
  assert.deepEqual(await check('http://127.0.0.1:1', key), { state: 'unreachable' });
});

test('the page transport names a way out in its 502', async (t) => {
  const { bash } = await booted(chrome, t, { hint: 'run npx @ai-ecoverse/slicc-node' });

  const { stdout } = await bash('curl -sS -w " %{http_code}" https://unreachable.invalid/');
  assert.match(stdout, /not allowed by CORS\): run npx @ai-ecoverse\/slicc-node/);
  assert.match(stdout, / 502$/);
});
