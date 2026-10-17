import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const READ = 'cat /home/f 2>&1; test -d /home/f && echo dir; true';

test('a file another tab removes, rewrites or replaces with a directory reads as it now is (#774)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  const there = (script) =>
    other.evaluate((s) => window.kernel.run(['bash', '-c', s], { cwd: '/' }), script);
  assert.deepEqual(await bash('printf one > /home/f; cat /home/f'), ok('one'));
  assert.deepEqual(await there('rm /home/f'), ok());
  assert.deepEqual(await bash(READ), ok('cat: /home/f: No such file or directory\n'));
  assert.deepEqual(await there('printf two > /home/f'), ok());
  assert.deepEqual(await bash(READ), ok('two'));
  assert.deepEqual(await there('rm /home/f && mkdir /home/f'), ok());
  assert.deepEqual(await bash(READ), ok('cat: /home/f: Is a directory\ndir\n'));
});

test('a file the page removes or rewrites through the OPFS API reads as it now is at once, and one it replaces with a directory within a second (#774)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const raw = (op) =>
    page.evaluate(async (o) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
      if (o !== 'write') await dir.removeEntry('g', { recursive: true });
      if (o === 'dir') await dir.getDirectoryHandle('g', { create: true });
      if (o === 'write') {
        const w = await (await dir.getFileHandle('g', { create: true })).createWritable();
        await w.write('three');
        await w.close();
      }
    }, op);
  const read = 'cat /home/g 2>&1; test -d /home/g && echo dir; true';
  assert.deepEqual(await bash('printf one > /home/g; cat /home/g'), ok('one'));
  await raw('rm');
  assert.deepEqual(await bash(read), ok('cat: /home/g: No such file or directory\n'));
  await raw('write');
  assert.deepEqual(await bash(read), ok('three'));
  await raw('dir');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(await bash(read), ok('cat: /home/g: Is a directory\ndir\n'));
});

test('a file another tab creates just after this tab found the name missing reads at the next command (#774)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  const there = (script) =>
    other.evaluate((s) => window.kernel.run(['bash', '-c', s], { cwd: '/' }), script);
  assert.deepEqual(await bash('rm -f /home/n; test -e /home/n || echo missing'), ok('missing\n'));
  assert.deepEqual(await there('printf made > /home/n'), ok());
  assert.deepEqual(await bash('cat /home/n'), ok('made'));
});

test('in the page, a write shows its size at once to the next stat, and an append loop counts up (#774)', async (t) => {
  const { bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash(
      'printf abc > /home/s && stat -c %s /home/s && printf de >> /home/s && stat -c %s /home/s'
    ),
    ok('3\n5\n')
  );
  const counts = Array.from({ length: 25 }, (_, i) => `${i + 1}\n`).join('');
  assert.deepEqual(
    await bash(
      'rm -f /home/a; for i in $(seq 25); do printf x >> /home/a; stat -c %s /home/a; done'
    ),
    ok(counts)
  );
});

test('in the page, a 170 KB file tee writes from stdin reads back with the same bytes (#774)', async (t) => {
  const { page } = await booted(chrome, t);
  const body = Array.from(
    { length: 4000 },
    (_, i) => `line ${i} of the upload ${'x'.repeat(i % 37)}\n`
  ).join('');
  const sum = createHash('sha256').update(body).digest('hex');
  const run = (argv, stdin) =>
    page.evaluate((a, s) => window.kernel.run(a, { cwd: '/home', stdin: s }), argv, stdin);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await run(['tee', 'up.txt'], body), ok(body));
    assert.deepEqual(await run(['sha256sum', 'up.txt']), ok(`${sum}  up.txt\n`));
  }
});
