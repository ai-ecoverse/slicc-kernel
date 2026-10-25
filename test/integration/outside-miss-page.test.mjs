import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a file the page writes through the OPFS API and posts a notice for, at a name the kernel has just found missing, is there for the very next run: cat, stat and open (#1693)', async (t) => {
  const { page, run } = await booted(chrome, t, { users: 'enforce' });
  await page.evaluate(() => window.kernel.users.add({ name: 'b' }));
  const as = { cwd: '/home/b', user: 'b' };
  const cases = [
    ['/home/b/x', ['/home/b']],
    ['/home/b/.config/bat/config', ['/home/b/.config/bat', '/home/b/.config']],
  ];
  for (const [path, dirs] of cases) {
    const before = await run(['cat', path], as);
    assert.equal(before.status, 1, JSON.stringify(before));
    await page.evaluate(
      async (p, d) => {
        await window.opfs.write(p.slice(1), 'hi\n');
        const { postFsNotice } = await import('/dist/meta.js');
        postFsNotice({ paths: [p, ...d] });
      },
      path,
      dirs
    );
    assert.deepEqual(await run(['cat', path], as), ok('hi\n'), path);
    assert.deepEqual(await run(['stat', '-c', '%s', path], { cwd: '/' }), ok('3\n'), path);
    assert.deepEqual(
      await run(['bash', '-c', `read -r v < ${path} && echo "$v"`], as),
      ok('hi\n'),
      path
    );
  }
});

test('a file the page writes through the OPFS API at a name the kernel has just found missing is still missing to a stat, and found once a listing of its directory shows it (#1693)', async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  assert.deepEqual(await bash('rm -rf /home/ls && mkdir /home/ls', { cwd: '/' }), ok());
  const seen = await page.evaluate(async () => {
    const { attachKernel } = await import('/dist/index.js');
    const { fs } = await attachKernel(await window.kernel.connect());
    const code = (p) =>
      p.then(
        () => 'found',
        (e) => e.code
      );
    const before = await code(fs.stat('/home/ls/q'));
    await window.opfs.write('home/ls/q', 'hi\n');
    const cached = await code(fs.stat('/home/ls/q'));
    const listed = await fs.readdir('/home/ls');
    const after = await code(fs.stat('/home/ls/q'));
    return { before, cached, listed, after };
  });
  assert.deepEqual(seen, { before: 'ENOENT', cached: 'ENOENT', listed: ['q'], after: 'found' });
});
