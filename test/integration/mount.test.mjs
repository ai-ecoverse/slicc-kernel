import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { launch } from './chrome.mjs';
import { hostfsProxy } from './hostfs-proxy.mjs';
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

async function sliccNode(dir, origin) {
  let key;
  const start = (port) =>
    startProxy({ port, origins: [origin], mounts: [`${dir}:project`], ...(key ? { key } : {}) });
  let proxy = await start(0);
  key = proxy.key;
  const port = new URL(proxy.url).port;
  return {
    url: proxy.url,
    key: proxy.key,
    stop: () => proxy.close(),
    async start() {
      proxy = await start(Number(port));
    },
    close: () => proxy.close().catch(() => undefined),
  };
}

async function hostFolder(t, makeProxy) {
  const stage = join(homedir(), 'Developer/ai-ecoverse/work/stage/hostfs-int');
  await mkdir(stage, { recursive: true });
  const dir = await mkdtemp(join(stage, 'host-'));
  const proxy = await makeProxy(dir);
  t.after(async () => {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-git');
  await page.evaluate(
    (p) => {
      window.hostfsProxy = p;
    },
    { url: proxy.url, key: proxy.key }
  );
  await bash('mkdir -p /mnt/h', { cwd: '/home' });
  const spec = { type: 'hostfs', source: 'project', target: '/mnt/h' };
  assert.equal((await page.evaluate((s) => window.kernel.mount(s), spec)).state, 'ok');
  assert.deepEqual(await bash(programs('/mnt/h'), { cwd: '/home' }), {
    status: 0,
    stdout: 'first\nmoved\na.txt\nc.txt\nd\n',
    stderr: '',
  });
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(await readFile(join(dir, 'c.txt'), 'utf8'), 'over\n');
  assert.ok((await stat(join(dir, '.git/HEAD'))).isFile());
  const big = await bash(
    'head -c 110000000 /dev/urandom > /mnt/h/big && sha256sum /mnt/h/big | cut -c1-64 && ls -l /mnt/h/big | cut -d" " -f5',
    { cwd: '/home' }
  );
  const host = createHash('sha256')
    .update(await readFile(join(dir, 'big')))
    .digest('hex');
  assert.deepEqual(big, { status: 0, stdout: `${host}\n110000000\n`, stderr: '' });
  await writeFile(join(dir, 'c.txt'), 'edited on the host\n');
  let seen = '';
  for (let i = 0; i < 100 && seen !== 'edited on the host\n'; i++) {
    seen = (await bash('cat /mnt/h/c.txt', { cwd: '/home' })).stdout;
    if (seen !== 'edited on the host\n') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(seen, 'edited on the host\n');
  await proxy.stop();
  const gone = await bash('sleep 1; cat /mnt/h/a.txt; echo "cat $?"', { cwd: '/home' });
  assert.equal(gone.stdout, 'cat 1\n');
  assert.equal(gone.stderr, 'cat: /mnt/h/a.txt: No medium found\n');
  await proxy.start();
  let state = '';
  for (let i = 0; i < 100 && state !== 'ok'; i++) {
    state = (await page.evaluate(() => window.kernel.mounts()))[0].state;
    if (state !== 'ok') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state, 'ok');
  assert.deepEqual(await bash('cat /mnt/h/a.txt', { cwd: '/home' }), {
    status: 0,
    stdout: 'one\ntwo\n',
    stderr: '',
  });
  await page.evaluate(() => window.kernel.umount('/mnt/h'));
  assert.deepEqual(page.errors, []);
}

test('hostfs against the mock proxy: programs and git work on a host folder, a file over 100 MB has no cap, host edits show up, and the mount survives the proxy restarting', (t) =>
  hostFolder(t, (dir) => hostfsProxy({ folders: { project: dir }, pingMs: 1000 })));

test('hostfs against slicc-node: the same run against the real local proxy', (t) =>
  hostFolder(t, (dir) => sliccNode(dir, new URL(chrome.url).origin)));

test('hostfs: a read-only mount refuses an append or read-write open of an existing file with EROFS at open, and the shell stays usable', async (t) => {
  const stage = join(homedir(), 'Developer/ai-ecoverse/work/stage/hostfs-int');
  await mkdir(stage, { recursive: true });
  const dir = await mkdtemp(join(stage, 'host-'));
  await writeFile(join(dir, 'a.txt'), 'host\n');
  const proxy = await hostfsProxy({ folders: { project: dir } });
  t.after(async () => {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(
    (p) => {
      window.hostfsProxy = p;
    },
    { url: proxy.url, key: proxy.key }
  );
  await bash('mkdir -p /mnt/r', { cwd: '/home' });
  const spec = { type: 'hostfs', source: 'project', target: '/mnt/r', options: { ro: '' } };
  assert.equal((await page.evaluate((s) => window.kernel.mount(s), spec)).state, 'ok');
  assert.deepEqual(
    await bash(
      'exec 4</mnt/r/a.txt; echo no >> /mnt/r/a.txt; echo "append $?"; exec 3<>/mnt/r/a.txt; echo "rdwr $?"; echo hi >&3; echo "fd3 $?"; : > /mnt/r/a.txt; cat <&4; cat /mnt/r/a.txt',
      { cwd: '/home' }
    ),
    {
      status: 0,
      stdout: 'append 1\nrdwr 1\nfd3 1\nhost\nhost\n',
      stderr: [
        'bash: line 1: /mnt/r/a.txt: Read-only file system',
        'bash: line 1: /mnt/r/a.txt: Read-only file system',
        'bash: line 1: 3: Bad file descriptor',
        'bash: line 1: /mnt/r/a.txt: Read-only file system',
        '',
      ].join('\n'),
    }
  );
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'host\n');
  await page.evaluate(() => window.kernel.umount('/mnt/r'));
  assert.deepEqual(page.errors, []);
});

test('a write the mount refuses after the program wrote it fails the next spawn with its errno, and crashes neither that spawn nor the exit', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await bash('mkdir -p /mnt/t', { cwd: '/home' });
  await page.evaluate(() =>
    window.kernel.mount({
      type: 'tmpfs',
      source: 'none',
      target: '/mnt/t',
      options: { maxfile: '10' },
    })
  );
  assert.deepEqual(
    await bash(
      'echo 1 > /mnt/t/c; exec 3>>/mnt/t/c; printf 0123456789abcdef >&3; sleep 0.1; echo "spawned $?"',
      { cwd: '/home' }
    ),
    { status: 0, stdout: 'spawned 126\n', stderr: 'bash: line 1: /usr/bin/sleep: File too large\n' }
  );
  assert.deepEqual(await bash('cat /mnt/t/c', { cwd: '/home' }), {
    status: 0,
    stdout: '1\n',
    stderr: '',
  });
  await page.evaluate(() => window.kernel.umount('/mnt/t'));
  assert.deepEqual(page.errors, []);
});

test('bytes a program wrote before a spawn whose write-back failed are kept, with what it wrote after, and reach the store once it takes them', async (t) => {
  const { page, bash } = await booted(chrome, t, { store: true });
  await fixture(page);
  await bash('mkdir -p /mnt/s3', { cwd: '/home' });
  const spec = { type: 'mocks3', source: 'http://mock-s3.test/bucket', target: '/mnt/s3' };
  assert.equal((await page.evaluate((s) => window.kernel.mount(s), spec)).state, 'ok');
  await bash('echo host > /mnt/s3/a.txt', { cwd: '/home' });
  const until = async (ok) => {
    for (let i = 0; i < 150 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 100));
  };
  await page.evaluate(() => {
    window.refusePuts = true;
  });
  const running = bash(
    [
      'exec 3>>/mnt/s3/a.txt',
      'printf "before\\n" >&3',
      'sleep 0.1',
      ': > /home/spawned',
      'while [ ! -e /home/up ]; do :; done',
      'printf "after\\n" >&3',
      'exec 3>&-',
      'echo "closed $?"',
    ].join('; '),
    { cwd: '/home' }
  );
  await until(() => page.evaluate(() => window.opfs.exists('home/spawned')));
  await page.evaluate(() => {
    window.refusePuts = false;
  });
  await page.evaluate(() => window.opfs.write('home/up', ''));
  assert.deepEqual(await running, {
    status: 0,
    stdout: 'closed 0\n',
    stderr: 'bash: line 1: /usr/bin/sleep: I/O error\n',
  });
  await page.evaluate(() => window.kernel.umount('/mnt/s3'));
  const stored = await page.evaluate(() =>
    new TextDecoder().decode(window.objects.get('a.txt')?.body ?? new Uint8Array())
  );
  assert.equal(stored, 'host\nbefore\nafter\n');
  assert.deepEqual(page.errors, []);
});
