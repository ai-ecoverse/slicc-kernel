import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const late = (tab, ms) =>
  tab.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const control = new BroadcastChannel('late-notice-control');
        const id = Math.random();
        control.onmessage = ({ data }) => {
          if (data?.done !== id) return;
          control.close();
          resolve();
        };
        control.postMessage({ set: { late: ms }, id });
      }),
    ms
  );

const WRITER = [
  'import os, time',
  "os.chdir('/root/ln')",
  "open('f', 'w').write('old')",
  "fd = os.open('f', os.O_RDWR)",
  "open('ready', 'w').close()",
  "while not os.path.exists('go'): time.sleep(0.01)",
  'errs = {}',
  'for _ in range(20):',
  '    try:',
  "        os.pwrite(fd, b'x', 0); os.fsync(fd)",
  '    except OSError as e:',
  '        errs[e.errno] = errs.get(e.errno, 0) + 1',
  '    time.sleep(0.02)',
  'print(errs)',
].join('\n');

test("a descriptor's write-back never lands in a file another tab renamed over its name, even before that tab's notice arrives (#1454)", {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t, { worker: '/rename/late-worker.js' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/ln && mkdir -p /root/ln && echo made')).stdout,
    'made\n'
  );
  await page.evaluate((s) => {
    window.writer = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, WRITER);
  while (!(await page.evaluate(() => window.opfs.exists('root/ln/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  await late(page, 3000);
  assert.equal(
    (await sh(other, 'cd /root/ln && printf NEWNEW > h && mv h f && : > go && echo replaced'))
      .stdout,
    'replaced\n'
  );
  const writer = await page.evaluate(() => window.writer);
  console.log(`writer: ${writer.stdout.trim()} ${writer.stderr.trim()}`);
  await late(page, 0);
  assert.equal(
    (await sh(other, 'cat /root/ln/f')).stdout,
    'NEWNEW',
    "the replacement took the writer's bytes"
  );
});
