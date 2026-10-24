import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const listen = (tab) =>
  tab.evaluate(() => {
    window.pauseLog = [];
    const channel = new BroadcastChannel('pause-control');
    channel.onmessage = ({ data }) => window.pauseLog.push(data);
    window.pauseSend = (msg) => channel.postMessage({ id: 'w', ...msg });
  });

const heard = async (tab, match) => {
  for (;;) {
    const log = await tab.evaluate(() => window.pauseLog);
    if (log.some((m) => match(m))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const WRITER = (dir) =>
  [
    'import os, time',
    `fd = os.open('${dir}/f', os.O_RDWR)`,
    `open('${dir}/opened', 'w').close()`,
    `while not os.path.exists('${dir}/go'): time.sleep(0.02)`,
    'try:',
    "    os.pwrite(fd, b'x', 0)",
    '    os.fsync(fd)',
    "    print('wrote')",
    'except OSError as e:',
    "    print('errno', e.errno)",
  ].join('\n');

test('a descriptor whose file another tab moved while its id was being assigned is never bound to the file made at its name (#1576)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t, { worker: '/rename/pause-worker.js?id=w' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  const dir = '/root/bmr';
  assert.deepEqual(
    await sh(page, `rm -rf ${dir} && mkdir -p ${dir} && echo old > ${dir}/f && echo made`),
    ok('made\n')
  );
  await listen(page);
  await page.evaluate((p) => window.pauseSend({ set: { pause: p }, seq: 1 }), `${dir}/f`);
  await heard(page, (m) => m.done === 1);
  await page.evaluate((s) => {
    window.writeRun = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, WRITER(dir));
  await heard(page, (m) => m.held === `${dir}/f`);
  assert.deepEqual(
    await sh(other, `cd ${dir} && mv f g && echo NEW > f && echo swapped`),
    ok('swapped\n')
  );
  await page.evaluate(() => window.pauseSend({ release: true, seq: 2 }));
  while (!(await page.evaluate((p) => window.opfs.exists(p), `${dir.slice(1)}/opened`)))
    await new Promise((resolve) => setTimeout(resolve, 20));
  await page.evaluate((p) => window.pauseSend({ set: { watch: p }, seq: 3 }), `${dir}/f`);
  await heard(page, (m) => m.done === 3);
  assert.deepEqual(await sh(other, `touch ${dir}/f && echo touched`), ok('touched\n'));
  await heard(page, (m) => m.seen === `${dir}/f`);
  await sh(page, `: > ${dir}/go`);
  const wrote = await page.evaluate(() => window.writeRun);
  console.log(`writer: ${wrote.stdout.trim()} ${wrote.stderr.trim()}`);
  assert.equal(
    (await sh(other, `cat ${dir}/f`)).stdout,
    'NEW\n',
    'the descriptor wrote into the file made at its name'
  );
});
