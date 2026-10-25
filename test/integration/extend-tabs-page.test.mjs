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
  await installPackage(page, 'wasm-coreutils');
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
  await installPackage(page, 'wasm-coreutils');
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
            resolve(data);
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
  console.log(
    `#1546 uncrowded: append locks ${locks1.taken - locks0.taken}, opfs ops ${ops1 - ops0}`
  );
  assert.deepEqual(r, ok('890\n'));
  assert.equal(locks1.taken - locks0.taken, 0);
});

const MB = 1024 * 1024;
const holder = [
  'import os',
  "fd = os.open('/root/ap/big', os.O_WRONLY | os.O_APPEND)",
  "open('/root/ap/held-big', 'w').close()",
  "while not os.path.exists('/root/ap/done'): pass",
  'os.close(fd)',
  "print('held')",
].join('\n');
const bigWriter = [
  'import os',
  "while not os.path.exists('/root/ap/held-big'): pass",
  "fd = os.open('/root/ap/big', os.O_WRONLY)",
  'for i in range(200):',
  '    os.lseek(fd, 0, os.SEEK_END)',
  "    os.write(fd, b'z%d\\n' % i)",
  'os.close(fd)',
  "open('/root/ap/done', 'w').close()",
  "print(os.path.getsize('/root/ap/big'))",
].join('\n');

for (const { kind, size, worker } of [
  { kind: 'ranged, 1 MB', size: MB, worker: '/lock-count-worker.js' },
  { kind: 'whole-file, 64 kB', size: 64 * 1024, worker: '/whole-count-worker.js' },
]) {
  test(`SEEK_END writes to a file another tab holds (${kind} buffer) each take the append lock, and none reads the file back (#1546)`, {
    timeout: 600_000,
  }, async (t) => {
    const { page } = await booted(chrome, t);
    await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
    await installPackage(page, 'wasm-coreutils');
    const other = await peerTab(page, { worker });
    assert.deepEqual(
      await sh(
        page,
        `rm -rf /root/ap && mkdir -p /root/ap && head -c ${size} /dev/zero > /root/ap/big && echo made`
      ),
      ok('made\n')
    );
    const counted = () =>
      other.evaluate(
        () =>
          new Promise((resolve) => {
            const c = new BroadcastChannel('lock-count');
            c.onmessage = ({ data }) => {
              c.close();
              resolve(data);
            };
            c.postMessage('?');
          })
      );
    const ops = async () => Number((await sh(other, 'cat /proc/sys/kernel/slicc_opfs_ops')).stdout);
    await page.evaluate((s) => {
      window.big_hold = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    }, holder);
    const [c0, ops0] = [await counted(), await ops()];
    const r = await other.evaluate(
      (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
      bigWriter
    );
    const [c1, ops1] = [await counted(), await ops()];
    const held = await page.evaluate(() => window.big_hold);
    console.log(
      `#1546 crowded ${kind}: append locks ${c1.taken - c0.taken}, opfs ops ${ops1 - ops0}, bytes read ${(c1.read.big ?? 0) - (c0.read.big ?? 0)}, by file ${JSON.stringify(c1.read)}`
    );
    assert.deepEqual(r, ok(`${size + 890}\n`));
    assert.deepEqual(held, ok('held\n'));
    assert.ok(c1.taken - c0.taken >= 200, `locks ${c1.taken - c0.taken}`);
    assert.ok(
      (c1.read.big ?? 0) - (c0.read.big ?? 0) < size,
      `read ${(c1.read.big ?? 0) - (c0.read.big ?? 0)} bytes`
    );
  });
}
