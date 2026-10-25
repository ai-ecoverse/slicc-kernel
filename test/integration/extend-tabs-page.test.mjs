import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const N = 40;
const turn = (n) => `'/root/ap/t%d' % (${n})`;
const appender = [
  'import os',
  "fd = os.open('/root/ap/log', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)",
  "open('/root/ap/held-x', 'w').close()",
  `for i in range(${N}):`,
  `    while not os.path.exists(${turn('2 * i')}): pass`,
  "    os.write(fd, b'x%d\\n' % i)",
  `    open(${turn('2 * i + 1')}, 'w').close()`,
  'os.close(fd)',
  "print('x done')",
].join('\n');
const seeker = [
  'import os',
  "while not os.path.exists('/root/ap/held-x'): pass",
  "fd = os.open('/root/ap/log', os.O_WRONLY)",
  `open(${turn(0)}, 'w').close()`,
  `for i in range(${N}):`,
  `    while not os.path.exists(${turn('2 * i + 1')}): pass`,
  '    os.lseek(fd, 0, os.SEEK_END)',
  "    os.write(fd, b'y%d\\n' % i)",
  `    open(${turn('2 * i + 2')}, 'w').close()`,
  'os.close(fd)',
  "print('y done')",
].join('\n');

for (let run = 0; run < 5; run++) {
  test(`run ${run}: a write at SEEK_END in one tab and O_APPEND writes in another, taking turns on one held file, keep every record in order, as on one Linux file, even when the SEEK_END tab never hears of the appends (#1546)`, {
    timeout: 600_000,
  }, async (t) => {
    const { page } = await booted(chrome, t);
    await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
    await installPackage(page, 'wasm-coreutils');
    const other = await peerTab(page, { worker: '/blind-worker.js?path=%2Froot%2Fap%2Flog' });
    assert.deepEqual(
      await sh(page, 'rm -rf /root/ap && mkdir -p /root/ap && : > /root/ap/log && echo made'),
      ok('made\n')
    );
    await page.evaluate((s) => {
      window.extend_x = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    }, appender);
    await other.evaluate((s) => {
      window.extend_y = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    }, seeker);
    const x = await page.evaluate(() => window.extend_x);
    const y = await other.evaluate(() => window.extend_y);
    assert.deepEqual([x.stdout, y.stdout], ['x done\n', 'y done\n'], JSON.stringify([x, y]));
    const want = Array.from({ length: N }, (_, i) => `x${i}\ny${i}\n`).join('');
    assert.deepEqual(await sh(page, 'cat /root/ap/log'), ok(want));
  });
}

const solo = [
  'import os',
  "fd = os.open('/root/ap/solo', os.O_WRONLY | os.O_CREAT, 0o644)",
  'for i in range(200):',
  '    os.lseek(fd, 0, os.SEEK_END)',
  "    os.write(fd, b'z%d\\n' % i)",
  'os.close(fd)',
  "print(os.path.getsize('/root/ap/solo'))",
].join('\n');

test('DO NOT MERGE: this diagnostic PR must never go green', () => {
  assert.fail('DO NOT MERGE');
});
