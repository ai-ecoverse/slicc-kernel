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

test('a file of several megabytes is read, overwritten and truncated in place in OPFS', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const script = [
    'head -c 8388608 /dev/urandom > big.bin',
    'a=$(md5sum big.bin | cut -c1-32); b=$(md5sum < big.bin | cut -c1-32); [ "$a" = "$b" ] && echo same',
    'head -c 196608 big.bin | tail -c 131072 | md5sum | cut -c1-32 > want',
    'dd if=big.bin of=big.bin bs=65536 skip=1 seek=100 count=2 conv=notrunc 2>/dev/null',
    'dd if=big.bin bs=65536 skip=100 count=2 2>/dev/null | md5sum | cut -c1-32 > got',
    '[ "$(cat want)" = "$(cat got)" ] && echo moved',
    'wc -c < big.bin',
    'truncate -s 1000000 big.bin && wc -c < big.bin',
  ].join('; ');
  assert.deepEqual(await bash(script), ok('same\nmoved\n8388608\n1000000\n'));
  assert.deepEqual(page.errors, []);
});

test('two kernels write one OPFS file at once without losing a block', async (t) => {
  const { page } = await booted(chrome, t);
  await page.evaluate(() => window.secondKernel({ metadata: false }));
  const run = (kernel, script) =>
    page.evaluate((k, s) => window[k].run(['bash', '-c', s]), kernel, script);
  const blocks = (letter, first) =>
    `for i in $(seq ${first} 2 31); do printf "%65536s" "" | tr " " ${letter} | dd of=/home/shared.bin bs=65536 seek=$i count=1 iflag=fullblock conv=notrunc 2>/dev/null || echo fail; done`;
  assert.deepEqual(await run('kernel', 'truncate -s 2097152 /home/shared.bin'), ok());
  const [a, b] = await Promise.all([run('kernel', blocks('A', 0)), run('second', blocks('B', 1))]);
  assert.deepEqual([a, b], [ok(), ok()]);
  assert.deepEqual(
    await run(
      'second',
      'tr -cd A < /home/shared.bin | wc -c; tr -cd B < /home/shared.bin | wc -c; wc -c < /home/shared.bin'
    ),
    ok('1048576\n1048576\n2097152\n')
  );
  await page.evaluate(() => window.second.terminate());
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
