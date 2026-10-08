import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const programs = (dir) =>
  [
    'git config --global user.name kernel && git config --global user.email kernel@example.com',
    `cd ${dir} && echo one > a.txt && echo two >> a.txt && printf three > b.txt && echo over > b.txt`,
    'mv b.txt c.txt && mkdir -p d/e && rmdir d/e && echo gone > g.txt && rm g.txt',
    'git init -q && git add . && git commit -qm first && git log --format=%s && git status --porcelain',
    'echo moved > m.txt && mv m.txt /home/m.txt && cat /home/m.txt && ls',
  ].join(' && ');

async function fixture(page) {
  const base = new URL('./fixtures/mock-s3/', import.meta.url);
  const names = (await readdir(base)).sort();
  await page.evaluate(
    (n) => window.copyTree('fixtures/mock-s3/', 'node_modules/mock-s3/', n),
    names
  );
}

test('tmpfs: programs and git work on it, a large file has no cap, it umounts once they are done, and a new tmpfs starts empty', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-git');
  await bash('mkdir -p /mnt/t', { cwd: '/home' });
  const mounted = await page.evaluate(() =>
    window.kernel.mount({ type: 'tmpfs', source: 'none', target: '/mnt/t' })
  );
  assert.equal(mounted.state, 'ok');
  assert.deepEqual(await bash(programs('/mnt/t'), { cwd: '/home' }), {
    status: 0,
    stdout: 'first\nmoved\na.txt\nc.txt\nd\n',
    stderr: '',
  });
  const big = await bash(
    'head -c 110000000 /dev/urandom > /mnt/t/big && ls -l /mnt/t/big | cut -d" " -f5 && cat /mnt/t/big | wc -c && cat /proc/mounts | tail -1',
    { cwd: '/home' }
  );
  assert.deepEqual(big, {
    status: 0,
    stdout: '110000000\n110000000\nnone /mnt/t tmpfs rw 0 0\n',
    stderr: '',
  });
  assert.deepEqual(await page.evaluate(() => window.kernel.umount('/mnt/t')), undefined);
  assert.deepEqual(await page.evaluate(() => window.kernel.mounts()), []);
  assert.deepEqual(await bash('ls -A /mnt/t; cat /home/m.txt', { cwd: '/home' }), {
    status: 0,
    stdout: 'moved\n',
    stderr: '',
  });
  await page.evaluate(() =>
    window.kernel.mount({ type: 'tmpfs', source: 'none', target: '/mnt/t' })
  );
  assert.deepEqual(await bash('ls -A /mnt/t | wc -l', { cwd: '/home' }), {
    status: 0,
    stdout: '0\n',
    stderr: '',
  });
  await page.evaluate(() => window.kernel.umount('/mnt/t'));
  assert.deepEqual(page.errors, []);
});

test('a package driver in its own worker mounts a mock S3; what programs wrote is in the store, and a remount shows it', async (t) => {
  const { page, bash } = await booted(chrome, t, { store: true });
  await installPackage(page, 'wasm-git');
  await fixture(page);
  await bash('mkdir -p /mnt/s3', { cwd: '/home' });
  const spec = { type: 'mocks3', source: 'http://mock-s3.test/bucket', target: '/mnt/s3' };
  assert.equal((await page.evaluate((s) => window.kernel.mount(s), spec)).state, 'ok');
  assert.deepEqual(await bash(programs('/mnt/s3'), { cwd: '/home' }), {
    status: 0,
    stdout: 'first\nmoved\na.txt\nc.txt\nd\n',
    stderr: '',
  });
  await page.evaluate(() => window.kernel.umount('/mnt/s3'));
  const stored = await page.evaluate(() => ({
    a: new TextDecoder().decode(window.objects.get('a.txt')?.body ?? new Uint8Array()),
    c: new TextDecoder().decode(window.objects.get('c.txt')?.body ?? new Uint8Array()),
    gone: window.objects.has('g.txt') || window.objects.has('m.txt'),
    git: [...window.objects.keys()].some((k) => k.startsWith('.git/objects/')),
  }));
  assert.deepEqual(stored, { a: 'one\ntwo\n', c: 'over\n', gone: false, git: true });
  await page.evaluate((s) => window.kernel.mount(s), spec);
  assert.deepEqual(
    await bash(
      'cd /mnt/s3 && cat a.txt c.txt && ls -l a.txt | cut -d" " -f5 && git log --format=%s && git status --porcelain && echo clean',
      { cwd: '/home' }
    ),
    { status: 0, stdout: 'one\ntwo\nover\n8\nfirst\nclean\n', stderr: '' }
  );
  await page.evaluate(() => window.kernel.umount('/mnt/s3'));
  assert.deepEqual(page.errors, []);
});

test('fsa: a drive with no medium fails with ENOMEDIUM and asks for a folder; once inserted, programs and git work on the folder, and a remount of the same drive needs no new folder', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-git');
  await bash('mkdir -p /mnt/f', { cwd: '/home' });
  const mounted = await page.evaluate(() =>
    window.kernel.mount({ type: 'fsa', source: 'none', target: '/mnt/f' })
  );
  assert.equal(mounted.state, 'nomedium');
  assert.match(mounted.source, /^fsa:[0-9a-f-]{36}$/);
  assert.deepEqual(
    await page.evaluate(() => window.pendingMedia.map(({ target, source }) => [target, source])),
    [['/mnt/f', mounted.source]]
  );
  assert.deepEqual(
    await bash(
      'cat /mnt/f/a.txt; echo "cat $?"; tail -1 /proc/mounts; df /mnt/f | tail -1 | tr -s " " | cut -d" " -f2,5',
      { cwd: '/home' }
    ),
    {
      status: 0,
      stdout: `cat 1\n${mounted.source} /mnt/f fsa rw 0 0\n0 -\n`,
      stderr: 'cat: /mnt/f/a.txt: No medium found\n',
    }
  );
  await page.evaluate(() => window.insertPending(0));
  assert.deepEqual(
    (await page.evaluate(() => window.kernel.mounts())).map((m) => m.state),
    ['ok']
  );
  assert.deepEqual(await bash(programs('/mnt/f'), { cwd: '/home' }), {
    status: 0,
    stdout: 'first\nmoved\na.txt\nc.txt\nd\n',
    stderr: '',
  });
  const folder = await page.evaluate(async () => ({
    a: await window.opfs.read('picked/a.txt'),
    c: await window.opfs.read('picked/c.txt'),
    gone: (await window.opfs.exists('picked/g.txt')) || (await window.opfs.exists('picked/m.txt')),
    git: await window.opfs.exists('picked/.git/HEAD'),
  }));
  assert.deepEqual(folder, { a: 'one\ntwo\n', c: 'over\n', gone: false, git: true });
  await page.evaluate(() => window.kernel.umount('/mnt/f'));
  const again = await page.evaluate(
    (source) => window.kernel.mount({ type: 'fsa', source, target: '/mnt/f' }),
    mounted.source
  );
  assert.equal(again.state, 'ok');
  assert.deepEqual(
    await bash(
      'cd /mnt/f && cat a.txt c.txt && git log --format=%s && git status --porcelain && echo clean',
      {
        cwd: '/home',
      }
    ),
    { status: 0, stdout: 'one\ntwo\nover\nfirst\nclean\n', stderr: '' }
  );
  await page.evaluate(() => window.kernel.umount('/mnt/f'));
  assert.equal(await page.evaluate(() => window.pendingMedia.length), 1);
  assert.deepEqual(page.errors, []);
});

test('fsa: with no medium, a mkdir in the mount point fails with ENOMEDIUM, and ls and stat show an empty directory', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await bash('mkdir -p /mnt/f', { cwd: '/home' });
  await page.evaluate(() => window.kernel.mount({ type: 'fsa', source: 'none', target: '/mnt/f' }));
  assert.deepEqual(
    await bash(
      'mkdir /mnt/f/d; echo "mkdir $?"; ls -A /mnt/f | wc -l; stat -c %F /mnt/f; test -d /mnt/f && echo dir',
      { cwd: '/home' }
    ),
    {
      status: 0,
      stdout: 'mkdir 1\n0\ndirectory\ndir\n',
      stderr: 'mkdir: cannot create directory ‘/mnt/f/d’: No medium found\n',
    }
  );
  await page.evaluate(() => window.kernel.umount('/mnt/f'));
  assert.deepEqual(page.errors, []);
});

test('fsa: with no medium, a WASI program below the mount point gets ENODEV', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasi-ripgrep');
  await bash('mkdir -p /mnt/f', { cwd: '/home' });
  await page.evaluate(() => window.kernel.mount({ type: 'fsa', source: 'none', target: '/mnt/f' }));
  const r = await bash('rg x /mnt/f/a.txt', { cwd: '/home' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No such device \(os error 43\)/);
  await page.evaluate(() => window.kernel.umount('/mnt/f'));
  assert.deepEqual(page.errors, []);
});
