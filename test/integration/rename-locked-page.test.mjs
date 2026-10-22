import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('in the page, a rename whose source a worker holds with a sync access handle fails with EBUSY and leaves no copy behind (#1449)', {
  timeout: 300_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  assert.equal(
    (await bash('mkdir -p /tmp && echo data > /tmp/a && echo ok', { cwd: '/' })).stdout,
    'ok\n'
  );
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.locker = new Worker('/lock-worker.js');
        window.unlocked = new Promise((done) => {
          window.locker.onmessage = ({ data }) => (data === 'locked' ? resolve() : done());
        });
        window.locker.postMessage({ path: 'tmp/a', ms: 5000 });
      })
  );
  const r = await bash('mv /tmp/a /tmp/b; echo mv=$?; ls /tmp; cat /tmp/a', { cwd: '/' });
  const unlockedFirst = await page.evaluate(() =>
    Promise.race([window.unlocked.then(() => true), Promise.resolve(false)])
  );
  assert.equal(unlockedFirst, false, 'the lock went away before mv finished');
  assert.match(r.stderr, /Resource busy/);
  assert.equal(r.stdout, 'mv=1\na\ndata\n');
  await page.evaluate(() => window.unlocked);
  assert.deepEqual(await bash('mv /tmp/a /tmp/b && ls /tmp && cat /tmp/b', { cwd: '/' }), {
    status: 0,
    stdout: 'b\ndata\n',
    stderr: '',
  });
});
