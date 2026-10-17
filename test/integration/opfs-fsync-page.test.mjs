import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const N = 20;

const WATCH = `cd /home/s; for i in $(seq ${N}); do : > r$i; until [ -e m$i ]; do [ -s f$i ]; done; [ -s f$i ] || echo "f$i empty"; done`;

test('a program that keeps looking at a file sees the bytes another kernel on the root wrote, synced and closed (#959)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash(`rm -rf /home/s && mkdir /home/s && cd /home/s && touch $(seq -f f%g ${N})`, {
      cwd: '/',
    }),
    ok()
  );
  const [watch, write] = await page.evaluate(
    async (n, script) => {
      await window.secondKernel({});
      return Promise.all([
        window.second.run(['bash', '-c', script], { cwd: '/' }),
        window.kernel.run(['jstest', 'fsyncfiles', '/home/s', String(n)], { cwd: '/' }),
      ]);
    },
    N,
    WATCH
  );
  assert.deepEqual(write, ok());
  assert.deepEqual(watch, ok());
});
