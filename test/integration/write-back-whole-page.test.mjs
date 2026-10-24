import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const WRITER = (dir) =>
  [
    'import os, time',
    `fd = os.open('${dir}/f', os.O_RDWR | os.O_CREAT)`,
    "os.write(fd, b'abc')",
    'os.fsync(fd)',
    `open('${dir}/opened', 'w').close()`,
    `while not os.path.exists('${dir}/go'): time.sleep(0.02)`,
    'try:',
    '    os.ftruncate(fd, 0)',
    "    os.pwrite(fd, b'whole', 0)",
    '    os.fsync(fd)',
    "    print('wrote')",
    'except OSError as e:',
    "    print('errno', e.errno)",
    `open('${dir}/byname', 'w').write('made')`,
  ].join('\n');

test('a whole-file write-back through a descriptor whose file vanished behind the kernel does not make the file again, on the root and under /etc; a write by name still does (#1498)', {
  timeout: 900_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  for (const dir of ['/root/wbw', '/etc/wbw']) {
    const parts = dir.slice(1).split('/');
    await bash(`rm -rf ${dir} && mkdir -p ${dir}`, { cwd: '/' });
    await page.evaluate((s) => {
      window.writeRun = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    }, WRITER(dir));
    while (!(await page.evaluate((p) => window.opfs.exists(p), `${parts.join('/')}/opened`)))
      await new Promise((resolve) => setTimeout(resolve, 10));
    await page.evaluate(async (parts) => {
      let at = await navigator.storage.getDirectory();
      for (const part of parts) at = await at.getDirectoryHandle(part);
      await at.removeEntry('f');
      await window.opfs.write(`${parts.join('/')}/go`, '');
    }, parts);
    const wrote = await page.evaluate(() => window.writeRun);
    console.log(`${dir}: ${wrote.stdout.trim()}`);
    assert.equal(wrote.status, 0, wrote.stderr);
    const there = await page.evaluate((p) => window.opfs.exists(p), `${parts.join('/')}/f`);
    assert.equal(
      there,
      false,
      `${dir}/f was made again by the write-back (${wrote.stdout.trim()})`
    );
    assert.equal(
      await page.evaluate((p) => window.opfs.read(p), `${parts.join('/')}/byname`),
      'made'
    );
  }
});
