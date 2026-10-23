import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const PROGRAM = (dir) =>
  [
    'import os, time',
    `fd = os.open('${dir}/f', os.O_RDWR)`,
    `open('${dir}/opened', 'w').close()`,
    `while not os.path.exists('${dir}/go'): time.sleep(0.02)`,
    `os.rename('${dir}/g', '${dir}/f')`,
    'out = []',
    'try:',
    '    out.append(os.pread(fd, 16, 0).decode().strip())',
    'except OSError as e:',
    "    out.append(f'read errno {e.errno}')",
    'try:',
    "    os.pwrite(fd, b'XXX', 0)",
    '    os.fsync(fd)',
    "    out.append('wrote')",
    'except OSError as e:',
    "    out.append(f'write errno {e.errno}')",
    "print(' / '.join(out))",
  ].join('\n');

test("a descriptor whose file can't be kept before the program renames another file over its name is ESTALE, and leaves the new file alone (#1415)", {
  timeout: 900_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const dir = '/root/kfs';
  await bash(`rm -rf ${dir} && mkdir -p ${dir} && echo old > ${dir}/f && echo NEW > ${dir}/g`, {
    cwd: '/',
  });
  await page.evaluate((s) => {
    window.run = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, PROGRAM(dir));
  while (!(await page.evaluate(() => window.opfs.exists('root/kfs/opened'))))
    await new Promise((resolve) => setTimeout(resolve, 10));
  await page.evaluate(async () => {
    const top = await navigator.storage.getDirectory();
    const at = await (await top.getDirectoryHandle('root')).getDirectoryHandle('kfs');
    await at.removeEntry('f');
    await window.opfs.write('root/kfs/go', '');
  });
  const r = await page.evaluate(() => window.run);
  console.log(`program: ${r.stdout.trim()}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^read errno 72 \/ write errno 72\n$/, r.stdout);
  assert.equal(await page.evaluate(() => window.opfs.read('root/kfs/f')), 'NEW\n');
});
