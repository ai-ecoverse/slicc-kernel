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

test("a program's writes through a descriptor follow another tab's plain moves of its file, and the mover always finds its file (#1442)", {
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
  assert.equal(mover.stderr, '', 'the mover lost its own file');
  assert.match(writer.stdout, /^\d+ \{\}\n$/, 'the writer saw errors');
});

test("what a program's descriptor writes see when another tab really removes its file (#1442, the baseline #1423 owns)", {
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
  await page.evaluate(
    (script) => {
      window.writer = window.kernel.run(['python3', '-c', script], { cwd: '/' });
    },
    WRITER.replace('end = time.time() + 40', 'end = time.time() + 8')
  );
  while (!(await page.evaluate(() => window.opfs.exists('root/rc/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const mover = await sh(other, 'cd /root/rc && rm f && sleep 2 && : > stop; echo removed');
  const writer = await page.evaluate(() => window.writer);
  console.log(`removed baseline: writer ${writer.stdout.trim()} ${writer.stderr.trim()}`);
  console.log(`removed baseline: mover ${JSON.stringify(mover)}`);
  assert.equal(mover.stdout, 'removed\n');
});
