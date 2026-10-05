import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('modes, times and symlinks survive a fresh kernel on the same OPFS', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(() =>
    window.opfs.write('os/hello.sh', '#!/bin/bash\necho "hello from $0"\n')
  );
  const setup = [
    'chmod 750 hello.sh',
    'touch -d "2001-02-03 04:05:06 UTC" hello.sh',
    'ln -s hello.sh link',
    'mkdir -p dir/sub && chmod 700 dir/sub',
  ].join(' && ');
  assert.deepEqual(await bash(setup), ok());
  const report =
    'stat -c "%A %Y %n" hello.sh; stat -c "%A %N" link; readlink link; ./link; stat -c "%A %n" dir/sub';
  const before = await bash(report);
  assert.deepEqual(
    before,
    ok(
      "-rwxr-x--- 981173106 hello.sh\nlrwxrwxrwx 'link' -> 'hello.sh'\nhello.sh\nhello from ./link\ndrwx------ dir/sub\n"
    )
  );

  await page.evaluate(() => window.reboot());
  assert.deepEqual(await bash(report), before);
  assert.deepEqual(await bash('./hello.sh'), ok('hello from ./hello.sh\n'));
  assert.deepEqual(page.errors, []);
});

test('files from the OPFS API get the defaults, and deleted ones leave no ghost', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(() => window.opfs.write('os/page.txt', 'from the page'));
  await page.evaluate(() => window.opfs.write('node_modules/tool/bin/run', 'x'));
  assert.deepEqual(
    await bash('stat -c "%A %n" page.txt /node_modules/tool/bin/run /node_modules/tool'),
    ok(
      '-rw-r--r-- page.txt\n-rwxr-xr-x /node_modules/tool/bin/run\ndrwxr-xr-x /node_modules/tool\n'
    )
  );

  assert.deepEqual(
    await bash('chmod 600 page.txt && ln -s page.txt alias && stat -c %a page.txt'),
    ok('600\n')
  );
  await page.evaluate(() => window.remove('os/page.txt'));
  assert.deepEqual(
    await bash(
      'ls; test -e page.txt || echo gone; readlink alias; cat alias 2>/dev/null || echo dangling'
    ),
    ok('alias\ngone\npage.txt\ndangling\n')
  );
  await page.evaluate(() => window.reboot());
  await page.evaluate(() => window.opfs.write('os/page.txt', 'again'));
  assert.deepEqual(await bash('stat -c %a page.txt; cat alias'), ok('644\nagain'));
});

test('a directory rename keeps the modes of everything inside it', async (t) => {
  const { bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash(
      'mkdir -p a/b && echo x > a/b/f && chmod 700 a/b && chmod 755 a/b/f && ln -s f a/b/l && mv a z && stat -c "%a %n" z/b z/b/f && readlink z/b/l && cat z/b/l'
    ),
    ok('700 z/b\n755 z/b/f\nf\nx\n')
  );
});

test('a symlink to an installed command runs it', async (t) => {
  const { bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('ln -s /bin/bash mybash && ./mybash -c "echo via link"'),
    ok('via link\n')
  );
});
