import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const STALL_MS = 27_000;

async function mounted(t) {
  const { page, bash } = await booted(chrome, t, { store: true });
  const base = new URL('./fixtures/mock-s3/', import.meta.url);
  const names = (await readdir(base)).sort();
  await page.evaluate(
    (n) => window.copyTree('fixtures/mock-s3/', 'node_modules/mock-s3/', n),
    names
  );
  await bash('mkdir -p /mnt/s3', { cwd: '/' });
  const spec = { type: 'mocks3', source: 'http://mock-s3.test/bucket', target: '/mnt/s3' };
  assert.equal((await page.evaluate((s) => window.kernel.mount(s), spec)).state, 'ok');
  const stall = (method, key) =>
    page.evaluate(
      ([m, k, ms]) => {
        window.s3Released = false;
        window.s3Stall = {
          method: m,
          key: k,
          until: new Promise((done) =>
            setTimeout(() => {
              window.s3Released = true;
              done();
            }, ms)
          ),
        };
      },
      [method, key, STALL_MS]
    );
  const released = () => page.evaluate(() => window.s3Released);
  const object = (key) =>
    page.evaluate((k) => {
      const o = window.objects.get(k);
      return o ? new TextDecoder().decode(o.body) : null;
    }, key);
  const puts = (key) => page.evaluate((k) => window.s3Puts.get(k) ?? 0, key);
  return { page, bash, stall, released, object, puts };
}

test('a read whose backend stops answering fails with EIO once nothing has come back for the deadline, and the program goes on; nothing else is blocked (#990)', {
  timeout: 300_000,
}, async (t) => {
  const { page, bash, stall, released } = await mounted(t);
  await page.evaluate(() =>
    window.objects.set('r.txt', { body: new TextEncoder().encode('kept\n'), mtime: Date.now() })
  );
  await stall('GET', 'r.txt');
  const r = await bash('cat /mnt/s3/r.txt; echo "rc=$?"; echo alive', { cwd: '/' });
  assert.equal(
    await released(),
    false,
    'the read gave up while the backend still had not answered'
  );
  assert.match(r.stdout, /^rc=1\nalive\n$/, JSON.stringify(r));
  assert.match(r.stderr, /I\/O error|Input\/output error/, JSON.stringify(r));
  assert.doesNotMatch(r.stderr, /timed out/i);
  while (!(await released())) await new Promise((done) => setTimeout(done, 500));
  await stall('GET', '*');
  const dark = await bash('cat /mnt/s3/r.txt; echo "rc=$?"; echo alive', { cwd: '/' });
  assert.equal(
    await released(),
    false,
    'with the whole backend silent, metadata too, the read still gives up first'
  );
  assert.match(dark.stdout, /^rc=1\nalive\n$/, JSON.stringify(dark));
  while (!(await released())) await new Promise((done) => setTimeout(done, 500));
});

test('a write whose backend stalls past the deadline waits like a hard mount and completes once the backend is back, exactly once; a SIGKILL ends a stalled write at once (#990)', {
  timeout: 300_000,
}, async (t) => {
  const { bash, stall, released, object, puts } = await mounted(t);
  assert.equal(
    (await bash('printf hello > /mnt/s3/w0.txt; echo "rc=$?"', { cwd: '/' })).stdout,
    'rc=0\n'
  );
  const once = await puts('w0.txt');
  await stall('PUT', 'w.txt');
  const w = await bash('printf hello > /mnt/s3/w.txt; echo "rc=$?"; cat /mnt/s3/w.txt', {
    cwd: '/',
  });
  assert.equal(await released(), true, 'the write waited for the backend');
  assert.equal(w.stdout, 'rc=0\nhello', JSON.stringify(w));
  assert.equal(w.stderr, '');
  assert.equal(await object('w.txt'), 'hello');
  assert.equal(
    await puts('w.txt'),
    once,
    'the stalled write reached the store no more often than an unstalled one'
  );
  await stall('PUT', 'k.txt');
  const k = await bash(
    '(printf x > /mnt/s3/k.txt) & p=$!; sleep 3; kill -9 $p; wait $p; echo "rc=$?"',
    {
      cwd: '/',
    }
  );
  assert.equal(
    await released(),
    false,
    'the SIGKILL ended the stalled write before the backend came back'
  );
  assert.equal(k.stdout, 'rc=137\n', JSON.stringify(k));
});

test("a JS program's synchronous read of a stalled backend gets EIO once nothing has come back for the deadline, and its synchronous write waits and lands once (#1033)", {
  timeout: 300_000,
}, async (t) => {
  const { page, bash, stall, released, object, puts } = await mounted(t);
  await page.evaluate(() =>
    window.objects.set('jr.txt', { body: new TextEncoder().encode('kept\n'), mtime: Date.now() })
  );
  await stall('GET', 'jr.txt');
  const r = await bash('jstest syncfs read /mnt/s3/jr.txt; echo alive', { cwd: '/' });
  assert.equal(
    await released(),
    false,
    'the read gave up while the backend still had not answered'
  );
  assert.equal(r.stdout, 'read EIO\nalive\n', JSON.stringify(r));
  while (!(await released())) await new Promise((done) => setTimeout(done, 500));
  await stall('GET', '*');
  const dark = await bash('jstest syncfs read /mnt/s3/jr.txt; echo alive', { cwd: '/' });
  assert.equal(
    await released(),
    false,
    'with the whole backend silent, metadata too, the read still gives up first'
  );
  assert.equal(dark.stdout, 'read EIO\nalive\n', JSON.stringify(dark));
  while (!(await released())) await new Promise((done) => setTimeout(done, 500));
  assert.equal(
    (await bash('jstest syncfs write /mnt/s3/jw0.txt hello', { cwd: '/' })).stdout,
    'wrote\n'
  );
  const once = await puts('jw0.txt');
  await stall('PUT', 'jw.txt');
  const w = await bash('jstest syncfs write /mnt/s3/jw.txt hello; cat /mnt/s3/jw.txt', {
    cwd: '/',
  });
  assert.equal(await released(), true, 'the write waited for the backend');
  assert.equal(w.stdout, 'wrote\nhello', JSON.stringify(w));
  assert.equal(await object('jw.txt'), 'hello');
  assert.equal(await puts('jw.txt'), once);
});
