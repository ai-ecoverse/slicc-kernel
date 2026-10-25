import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const WRITER = [
  'import os, time',
  "os.chdir('/root/rc')",
  "open('f', 'w').write('old')",
  "fd = os.open('f', os.O_RDWR)",
  "open('ready', 'w').close()",
  'errs = {}; n = 0',
  'end = time.time() + 40',
  'while time.time() < end:',
  '    try:',
  "        os.pwrite(fd, b'x', 0); os.fsync(fd)",
  '    except OSError as e:',
  '        errs[e.errno] = errs.get(e.errno, 0) + 1',
  '    n += 1',
  "    if os.path.exists('stop'): break",
  'print(n, errs)',
].join('\n');

test("a program's writes through a descriptor follow another tab's plain moves of its file, 120 of them, with no errors (#1454, #1442)", {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/rc && mkdir -p /root/rc && echo made')).stdout,
    'made\n'
  );
  await page.evaluate((script) => {
    window.writer = window.kernel.run(['python3', '-c', script], { cwd: '/' });
  }, WRITER);
  while (!(await page.evaluate(() => window.opfs.exists('root/rc/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const mover = await sh(
    other,
    'cd /root/rc && for i in $(seq 1 60); do mv f g; mv g f; done; : > stop; echo moved'
  );
  const writer = await page.evaluate(() => window.writer);
  console.log(`writer: ${writer.stdout.trim()} ${writer.stderr.trim()}`);
  console.log(`mover: ${JSON.stringify(mover)}`);
  assert.equal(mover.stdout, 'moved\n');
  assert.match(writer.stdout, /^\d+ \{\}\n$/, 'the writer saw errors');
});

const steer = (tab, msg) =>
  tab.evaluate(
    (m) =>
      new Promise((resolve) => {
        const channel = new BroadcastChannel('pause-control');
        const seq = Math.random();
        channel.onmessage = ({ data }) => {
          if (data?.done !== seq) return;
          channel.close();
          resolve();
        };
        channel.postMessage({ id: 'w', seq, ...m });
      }),
    msg
  );

test("a descriptor's write after another tab moved its file waits for the move to arrive, even when it comes late (#1442)", {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t, { worker: '/rename/pause-worker.js?id=w' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/rl && mkdir -p /root/rl && echo made')).stdout,
    'made\n'
  );
  const script = [
    'import os, time',
    "os.chdir('/root/rl')",
    "open('f', 'w').write('old')",
    "fd = os.open('f', os.O_RDWR)",
    "open('ready', 'w').close()",
    "while not os.path.exists('go'): time.sleep(0.01)",
    'try:',
    "    os.pwrite(fd, b'x', 0); os.fsync(fd)",
    "    print('wrote')",
    'except OSError as e:',
    "    print('errno', e.errno)",
  ].join('\n');
  await page.evaluate((s) => {
    window.writer = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, script);
  while (!(await page.evaluate(() => window.opfs.exists('root/rl/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  await steer(page, { set: { freeze: true } });
  assert.equal(
    (await sh(other, 'cd /root/rl && mv f g && : > go && echo moved')).stdout,
    'moved\n'
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  await steer(page, { thaw: true });
  const writer = await page.evaluate(() => window.writer);
  console.log(`late move: ${writer.stdout.trim()} ${writer.stderr.trim()}`);
  assert.equal(writer.stdout, 'wrote\n');
  assert.equal((await sh(other, 'cat /root/rl/g')).stdout, 'xld');
});
