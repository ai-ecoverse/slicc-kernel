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

test("a watch hears another tab's changes on a shared OPFS root by name, and a watch on a sibling directory hears none of them (#1391)", {
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
      [
        'bash',
        '-c',
        'watchtest events /tmp/s end /tmp/rs stream > /tmp/os & watchtest events /tmp/w end /tmp/r stream > /tmp/o; wait; cat /tmp/o; echo --; cat /tmp/os',
      ],
      { cwd: '/' }
    );
  });
  const ready = () =>
    page.evaluate(async () => (await window.opfs.exists('tmp/r')) && window.opfs.exists('tmp/rs'));
  while (!(await ready())) await sleep(20);
  assert.equal(
    (await sh(other, 'echo x > /tmp/w/x && echo more >> /tmp/w/e && mkdir /tmp/w/d && echo done'))
      .stdout,
    'done\n'
  );
  await sleep(2000);
  await sh(page, 'touch /tmp/w/end /tmp/s/end');
  const finished = await Promise.race([
    page.evaluate(() => window.watched),
    sleep(15_000).then(() => undefined),
  ]);
  if (!finished) {
    const partial = await sh(page, 'cat /tmp/o; echo --; cat /tmp/os');
    assert.fail(`a watch never heard its end: ${JSON.stringify(partial.stdout)}`);
  }
  const [watched, sibling] = finished.stdout.split('--\n');
  const heard = lines(watched);
  assert.equal(heard.at(-1), 'rename end', watched);
  for (const want of ['rename x', 'change x', 'change e', 'rename d'])
    assert.ok(heard.includes(want), `${want} missing from ${JSON.stringify(heard)}`);
  assert.deepEqual(
    [...new Set(heard)].filter((line) => !/^(?:rename|change) (?:x|e|d|end)$/.test(line)),
    [],
    watched
  );
  assert.deepEqual(lines(sibling), ['rename end'], 'a sibling watch heard the peer');
});

test("a watch on a single file hears another tab's write to it as a change (#1391 review)", {
  timeout: 300_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /tmp/fw && mkdir -p /tmp/fw && echo {} > /tmp/fw/c.json && echo made'))
      .stdout,
    'made\n'
  );
  await page.evaluate(() => {
    window.watchedFile = window.kernel.run(
      ['bash', '-c', 'watchtest events /tmp/fw/c.json c.json /tmp/fw/r'],
      { cwd: '/' }
    );
  });
  while (!(await page.evaluate(() => window.opfs.exists('tmp/fw/r')))) await sleep(20);
  assert.equal(
    (await sh(other, 'echo \'{"a":1}\' > /tmp/fw/c.json && echo done')).stdout,
    'done\n'
  );
  assert.deepEqual(lines((await page.evaluate(() => window.watchedFile)).stdout), [
    'change c.json',
  ]);
});
