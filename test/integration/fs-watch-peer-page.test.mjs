import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const lines = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .filter((line, i, all) => line !== all[i - 1]);

test("a watch hears another tab's changes on a shared OPFS root, by name and in order (#1391)", {
  timeout: 300_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  const other = await peerTab(page);
  assert.equal(
    (
      await sh(
        page,
        'rm -rf /tmp/w /tmp/r /tmp/o && mkdir -p /tmp/w && echo old > /tmp/w/e && echo made'
      )
    ).stdout,
    'made\n'
  );
  await page.evaluate(() => {
    window.watched = window.kernel.run(
      ['bash', '-c', 'watchtest events /tmp/w end /tmp/r > /tmp/o; cat /tmp/o'],
      { cwd: '/' }
    );
  });
  while (!(await page.evaluate(() => window.opfs.exists('tmp/r')))) await sleep(20);
  assert.equal(
    (await sh(other, 'echo x > /tmp/w/x && echo more >> /tmp/w/e && mkdir /tmp/w/d && echo done'))
      .stdout,
    'done\n'
  );
  await sleep(2000);
  await sh(page, 'touch /tmp/w/end');
  const heard = lines((await page.evaluate(() => window.watched)).stdout);
  assert.deepEqual(heard, ['rename x', 'change x', 'change e', 'rename d', 'rename end']);
});
