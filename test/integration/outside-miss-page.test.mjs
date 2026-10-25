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

test('in a running shell, a file the page writes through the OPFS API at a name the kernel has just found missing is there once a listing shows it (#1693)', async (t) => {
  const { page } = await booted(chrome, t, { users: 'enforce' });
  await page.evaluate(() => window.kernel.users.add({ name: 'b' }));
  const screen = await page.evaluate(async () => {
    await window.terminal(
      [
        'bash',
        '-c',
        'cat /home/b/z 2>/dev/null || echo first-missing; read -r go; echo /home/b/*; cat /home/b/z 2>/dev/null || echo then-missing; echo done',
      ],
      { cwd: '/home/b', user: 'b' }
    );
    const shown = window.term.onData;
    let wrote = false;
    window.term.onData = (bytes) => {
      shown(bytes);
      if (wrote || !window.screen.screen.includes('first-missing')) return;
      wrote = true;
      window.opfs.write('home/b/z', 'hi\n').then(() => window.term.write('\r'));
    };
    while (window.screen.status === null) await new Promise((r) => setTimeout(r, 5));
    return window.screen.screen;
  });
  assert.match(screen, /\/home\/b\/z\r\nhi\r\ndone\r\n$/, JSON.stringify(screen));
});
