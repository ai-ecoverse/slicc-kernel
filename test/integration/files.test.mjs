import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('each file change is in OPFS as soon as the command exits', async (t) => {
  const { page, bash, read, list, exists } = await booted(chrome, t);

  assert.deepEqual(await bash('echo first > notes.txt'), ok());
  assert.equal(await read('os/notes.txt'), 'first\n');

  assert.deepEqual(await bash('echo second >> notes.txt'), ok());
  assert.equal(await read('os/notes.txt'), 'first\nsecond\n');

  assert.deepEqual(await bash('mv notes.txt renamed.txt'), ok());
  assert.deepEqual(await list('os'), ['renamed.txt']);
  assert.equal(await read('os/renamed.txt'), 'first\nsecond\n');

  assert.deepEqual(await bash('rm renamed.txt'), ok());
  assert.deepEqual(await list('os'), []);
  assert.equal(await exists('os/renamed.txt'), false);
  assert.deepEqual(page.errors, []);
});

test('directories are created, renamed with their contents, and removed', async (t) => {
  const { bash, read, list, exists } = await booted(chrome, t);

  assert.deepEqual(await bash('mkdir -p a/b && printf deep > a/b/c.txt'), ok());
  assert.equal(await read('os/a/b/c.txt'), 'deep');

  assert.deepEqual(await bash('mv a z'), ok());
  assert.deepEqual(await list('os'), ['z']);
  assert.equal(await read('os/z/b/c.txt'), 'deep');

  assert.deepEqual(await bash('rm -r z'), ok());
  assert.equal(await exists('os/z'), false);
});

test('commands see files written through the OPFS API', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(() => window.opfs.write('os/from-page.txt', 'written by the page\n'));

  assert.deepEqual(
    await bash('cat from-page.txt; wc -c < from-page.txt'),
    ok('written by the page\n20\n')
  );
});

test('an executable script runs through its #! line', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(() =>
    window.opfs.write('os/hello.sh', '#!/usr/bin/env bash\necho "hello from $0 with $1"\n')
  );

  assert.deepEqual(
    await bash('chmod +x hello.sh && ./hello.sh arg'),
    ok('hello from ./hello.sh with arg\n')
  );
});

test('/tmp and /home are in OPFS, shared by every process', async (t) => {
  const { bash, read } = await booted(chrome, t);

  assert.deepEqual(
    await bash('echo shared > /tmp/note; cat /tmp/note; echo "$HOME"'),
    ok('shared\n/home\n')
  );
  assert.equal(await read('tmp/note'), 'shared\n');
});

test('an executable without #! runs as a shell script', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(() => window.opfs.write('os/plain', 'echo "plain script $1"\nexit 4\n'));

  assert.deepEqual(
    await bash('chmod +x plain; ./plain one; echo "status $?"'),
    ok('plain script one\nstatus 4\n')
  );
});

test('du counts the blocks a file takes, and df reports the origin quota and usage', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const du = await bash(
    'head -c 300000 /dev/urandom > big.bin && du -B1 big.bin && du -sh big.bin'
  );
  assert.equal(du.status, 0, du.stderr);
  const [bytes] = du.stdout.split('\n')[0].split('\t');
  assert.ok(Number(bytes) >= 300000 && Number(bytes) < 300000 + 4096, du.stdout);
  assert.match(du.stdout, /^296K\tbig\.bin$/m);

  const df = await bash('df -B1 /; cat /etc/mtab');
  const estimate = await page.evaluate(async () => {
    const { quota, usage } = await navigator.storage.estimate();
    return { quota, usage };
  });
  assert.equal(df.status, 0, df.stderr);
  assert.equal(df.stderr, '');
  const [, row] = df.stdout.split('\n');
  const [name, size, used, avail, , mounted] = row.split(/\s+/);
  assert.deepEqual([name, mounted], ['opfs', '/']);
  const near = (actual, expected) => Math.abs(Number(actual) - expected) < 1024 * 1024;
  assert.ok(near(size, estimate.quota), row);
  assert.ok(near(used, estimate.usage), row);
  assert.ok(near(avail, estimate.quota - estimate.usage), row);
  assert.match(
    df.stdout,
    /^opfs \/ opfs rw 0 0\ndevfs \/dev devfs rw 0 0\nproc \/proc proc rw 0 0$/m
  );
  const blocks = await bash('stat -f -c %b / /dev');
  assert.deepEqual(blocks.stdout.trim().split('\n'), [
    String(Math.ceil(estimate.quota / 4096)),
    '1000000',
  ]);
  assert.deepEqual(page.errors, []);
});
