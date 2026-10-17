import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const RENAMES = 1000;
const STALL_MS = 40_000;

test('on the OPFS root, a file renamed over again and again while other processes keep reading it never hangs a read, a rename or a stat: the renames all finish (#980)', {
  timeout: 1_800_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  const made = await bash(
    'mkdir -p /root/swap && echo 0 > /root/swap/f && : > /root/swap/progress',
    {
      cwd: '/',
    }
  );
  assert.equal(made.status, 0, made.stderr);
  await page.evaluate((renames) => {
    const script = [
      'cd /root/swap',
      'for r in 1 2 3 4 5 6; do (while [ ! -e stop ]; do cat f > /dev/null 2>> err; stat f > /dev/null 2>> err; done) & done',
      `for i in $(seq 1 ${renames}); do echo $i > t.$i; mv t.$i f; echo $i >> progress; done`,
      ': > stop',
      'wait',
      'echo done',
    ].join('\n');
    window.__swap = { done: false };
    window.kernel.run(['bash', '-c', script], { cwd: '/' }).then(
      (r) => {
        window.__swap = { done: true, r };
      },
      (e) => {
        window.__swap = { done: true, error: String(e) };
      }
    );
  }, RENAMES);
  let seen = -1;
  let since = Date.now();
  let state;
  for (;;) {
    state = await page.evaluate(() => window.__swap);
    if (state.done) break;
    const progress = await page.evaluate(() =>
      window.opfs.read('root/swap/progress').catch(() => '')
    );
    const count = String(progress).split('\n').filter(Boolean).length;
    if (count !== seen) {
      seen = count;
      since = Date.now();
    }
    assert.ok(
      Date.now() - since < STALL_MS,
      `no rename finished for ${STALL_MS / 1000} s, after ${seen} of ${RENAMES}`
    );
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(state.r?.stdout.trim(), 'done', JSON.stringify(state));
  const last = await bash(
    'cat /root/swap/f; wc -l < /root/swap/progress; cat /root/swap/err 2> /dev/null | head -5',
    { cwd: '/' }
  );
  assert.equal(last.stdout.split('\n').slice(0, 2).join(' '), `${RENAMES} ${RENAMES}`, last.stdout);
});
