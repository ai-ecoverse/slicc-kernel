import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const READER = (dir) =>
  [
    'import os, time',
    `fd = os.open('${dir}/f', os.O_RDWR)`,
    `open('${dir}/ready', 'w').close()`,
    `while not os.path.exists('${dir}/go'): time.sleep(0.02)`,
    'try:',
    '    print(os.pread(fd, 16, 0).decode().strip())',
    'except OSError as e:',
    "    print('errno', e.errno)",
  ].join('\n');

async function swapped(page, { dir, early }) {
  assert.deepEqual(
    await sh(page, `rm -rf ${dir} && mkdir -p ${dir} && echo old > ${dir}/f && echo made`),
    ok('made\n')
  );
  const ids = Number((await sh(page, 'cat /proc/sys/kernel/slicc_file_ids')).stdout);
  const other = early ? await peerTab(page) : undefined;
  await page.evaluate((s) => {
    window.readRun = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, READER(dir));
  for (;;) if ((await sh(page, `[ -e ${dir}/ready ] && echo y || echo n`)).stdout === 'y\n') break;
  const peer = other ?? (await peerTab(page));
  assert.deepEqual(
    await sh(peer, `rm ${dir}/f && echo NEW > ${dir}/f && : > ${dir}/go && echo swapped`),
    ok('swapped\n')
  );
  const read = await page.evaluate(() => window.readRun);
  console.log(`read ${read.stdout.trim()}`);
  assert.equal(read.status, 0, read.stderr);
  assert.notEqual(
    read.stdout,
    'NEW\n',
    'the descriptor read the file another tab made at its name'
  );
  assert.match(read.stdout, /^(old|errno \d+)\n$/, read.stdout);
  const assigned = Number((await sh(page, 'cat /proc/sys/kernel/slicc_file_ids')).stdout) - ids;
  assert.ok(assigned > 0, `no file id was assigned while shared (${assigned})`);
}

test('a file held before another tab joins is not read through a name that tab removed and made again (#1454)', {
  timeout: 900_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  assert.deepEqual(await sh(page, 'cat /proc/sys/kernel/slicc_file_ids'), ok('0\n'));
  await swapped(page, { dir: '/root/fidjoin', early: false });
});

test('a file opened while another tab shares the root is not read through a name that tab removed and made again (#1454)', {
  timeout: 900_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await swapped(page, { dir: '/root/fidshared', early: true });
});
