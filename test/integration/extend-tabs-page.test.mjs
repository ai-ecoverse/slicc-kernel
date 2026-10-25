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

test('a write at SEEK_END in one tab and O_APPEND writes in another, taking turns on one held file, keep every record in order, as on one Linux file (#1546)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
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

const solo = [
  'import os',
  "fd = os.open('/root/ap/solo', os.O_WRONLY | os.O_CREAT, 0o644)",
  'for i in range(200):',
  '    os.lseek(fd, 0, os.SEEK_END)',
  "    os.write(fd, b'z%d\\n' % i)",
  'os.close(fd)',
  "print(os.path.getsize('/root/ap/solo'))",
].join('\n');

test('on a shared root, SEEK_END writes to a file no other tab holds stay buffered: no append lock is taken (#1546)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page, { worker: '/lock-count-worker.js' });
  assert.deepEqual(
    await sh(other, 'rm -rf /root/ap && mkdir -p /root/ap && echo made'),
    ok('made\n')
  );
  const taken = () =>
    other.evaluate(
      () =>
        new Promise((resolve) => {
          const c = new BroadcastChannel('lock-count');
          c.onmessage = ({ data }) => {
            c.close();
            resolve(data.taken);
          };
          c.postMessage('?');
        })
    );
  const ops = async () => Number((await sh(other, 'cat /proc/sys/kernel/slicc_opfs_ops')).stdout);
  const [locks0, ops0] = [await taken(), await ops()];
  const r = await other.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    solo
  );
  const [locks1, ops1] = [await taken(), await ops()];
  console.log(`#1546 uncrowded: append locks ${locks1 - locks0}, opfs ops ${ops1 - ops0}`);
  assert.deepEqual(r, ok('890\n'));
  assert.equal(locks1 - locks0, 0);
});
