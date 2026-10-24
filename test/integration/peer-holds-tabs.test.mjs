import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const counts = async (tab) =>
  (await sh(tab, 'cat /proc/sys/kernel/slicc_peer_holds')).stdout.trim().split(' ').map(Number);

const until = async (check) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

test("a tab's peers learn which root files it holds open, and forget them when it closes them (#1409)", {
  timeout: 900_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  assert.deepEqual(
    await sh(page, 'mkdir -p /root/ph && echo x > /root/ph/f && echo made'),
    ok('made\n')
  );
  assert.equal((await counts(other))[1], 0);
  await page.evaluate(() => {
    window.holding = window.kernel.run(
      [
        'bash',
        '-c',
        'exec 3< /root/ph/f; : > /root/ph/opened; until [ -e /root/ph/go ]; do :; done; exec 3<&-',
      ],
      { cwd: '/' }
    );
  });
  assert.ok(
    await until(async () => (await sh(page, '[ -e /root/ph/opened ] && echo y')).stdout === 'y\n')
  );
  const [, peers] = await counts(other);
  console.log(`while held: mine ${(await counts(page)).join(' ')}, peer ${peers}`);
  assert.ok(peers >= 1, 'the other tab did not learn of the hold');
  await sh(page, ': > /root/ph/go');
  assert.equal((await page.evaluate(() => window.holding)).status, 0);
  assert.ok(
    await until(async () => (await counts(other))[1] === 0),
    'the other tab kept a closed hold'
  );
  await other.close();
});
