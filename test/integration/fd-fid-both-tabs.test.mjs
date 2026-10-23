import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const WRITER = (dir, tag, slot) =>
  [
    'import os, time',
    `fd = os.open('${dir}/a/log', os.O_WRONLY | os.O_CREAT)`,
    `open('${dir}/ready-${tag}', 'w').close()`,
    'n = 0',
    'end = None',
    'try:',
    '    while n < 20000:',
    `        os.pwrite(fd, f'${tag}{n:06d}\\n'.encode(), ${slot} * 1048576 + n * 8)`,
    '        os.fsync(fd)',
    '        n += 1',
    `        if end is None and os.path.exists('${dir}/b/moved'): end = n + 50`,
    '        if end is not None and n >= end: break',
    "    print(n, 'ok')",
    'except OSError as e:',
    "    print(n, 'errno', e.errno)",
  ].join('\n');

test("two tabs that hold one file both follow another tab's move of it, with no stale descriptor (#1454)", {
  timeout: 1_200_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  for (let round = 0; round < 3; round++) {
    const dir = `/root/fidboth-${round}`;
    assert.deepEqual(
      await sh(page, `rm -rf ${dir} && mkdir -p ${dir}/a && echo made`),
      ok('made\n')
    );
    const stale = Number((await sh(page, 'cat /proc/sys/kernel/slicc_stale_fds')).stdout);
    for (const [tab, tag, slot] of [
      [page, 'x', 0],
      [other, 'y', 1],
    ]) {
      await tab.evaluate(
        (s) => {
          window.writeRun = window.kernel.run(['python3', '-c', s], { cwd: '/' });
        },
        WRITER(dir, tag, slot)
      );
    }
    for (const tag of ['x', 'y'])
      for (;;)
        if ((await sh(page, `[ -e ${dir}/ready-${tag} ] && echo y || echo n`)).stdout === 'y\n')
          break;
    assert.deepEqual(
      await sh(other, `mv ${dir}/a ${dir}/b && : > ${dir}/b/moved && echo moved`),
      ok('moved\n')
    );
    const runs = [
      await page.evaluate(() => window.writeRun),
      await other.evaluate(() => window.writeRun),
    ];
    console.log(`round ${round}: ${runs.map((r) => r.stdout.trim()).join(' / ')}`);
    for (const r of runs) assert.match(r.stdout, /^\d+ ok\n$/, `${r.stdout} ${r.stderr}`);
    const after = Number((await sh(page, 'cat /proc/sys/kernel/slicc_stale_fds')).stdout);
    assert.equal(after - stale, 0, 'a descriptor was stale');
    const log = await page.evaluate((p) => window.opfs.read(p), `${dir.slice(1)}/b/log`);
    const count = (tag) =>
      log.split('\n').filter((line) => line.replace(/^\0+/, '').startsWith(tag)).length;
    assert.deepEqual(
      [count('x'), count('y')],
      runs.map((r) => Number(r.stdout.split(' ')[0])),
      'every write is at the new name'
    );
  }
});
