import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const N = 50;
const CAP_MS = 100;
const IN_FLIGHT_MS = 25;

test('a kernel sharing the root with another finds a name the other just created once its notice arrives, and never more than 100 ms after the create returned (#945, #1425)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(await bash('rm -rf /home/p && mkdir /home/p', { cwd: '/' }), ok());
  const [watch, write] = await page.evaluate(async (n) => {
    await window.secondKernel({});
    return Promise.all([
      window.second.run(['jstest', 'peerwatch', '/home/p'], { cwd: '/' }),
      window.kernel.run(['jstest', 'peerwrite', '/home/p', String(n)], { cwd: '/' }),
    ]);
  }, N);
  assert.equal(write.status, 0, write.stderr);
  assert.equal(watch.status, 0, watch.stderr);
  const done = JSON.parse(write.stdout);
  const { missed, k } = JSON.parse(watch.stdout);
  assert.equal(k, N + 1, watch.stdout);
  const late = Object.entries(missed)
    .filter(([i, at]) => at > done[Number(i) - 1] + CAP_MS + IN_FLIGHT_MS)
    .map(([i]) => `n${i}`);
  assert.deepEqual(late, []);
});
