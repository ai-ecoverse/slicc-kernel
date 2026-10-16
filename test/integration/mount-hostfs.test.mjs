import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { hostfsProxy } from './hostfs-proxy.mjs';
import { booted } from './kernel.mjs';
import { hostFolder } from './mount-host.mjs';

const chrome = await launch();
after(() => chrome.close());

test('hostfs against the mock proxy: programs and git work on a host folder, a file over 100 MB has no cap, host edits show up, and the mount survives the proxy restarting', (t) =>
  hostFolder(chrome, t, (dir) => hostfsProxy({ folders: { project: dir }, pingMs: 1000 })));

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

test('hostfs over a port the page drops: Chromium sends no close, the heartbeat finds it within seconds, and the mount reconnects through the hook without a remount', async (t) => {
  const stage = join(homedir(), 'Developer/ai-ecoverse/work/stage/hostfs-int');
  await mkdir(stage, { recursive: true });
  const dir = await mkdtemp(join(stage, 'port-'));
  await writeFile(join(dir, 'a.txt'), 'over a port\n');
  const proxy = await hostfsProxy({ folders: { project: dir } });
  t.after(async () => {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(
    (p) => {
      window.hostfsProxy = p;
      window.hostfsOverPort = true;
    },
    { url: proxy.url, key: proxy.key }
  );
  await bash('mkdir -p /mnt/p', { cwd: '/home' });
  const spec = { type: 'hostfs', source: 'project', target: '/mnt/p' };
  assert.equal((await page.evaluate((s) => window.kernel.mount(s), spec)).state, 'ok');
  assert.deepEqual(await bash('cat /mnt/p/a.txt', { cwd: '/home' }), {
    status: 0,
    stdout: 'over a port\n',
    stderr: '',
  });
  await page.evaluate(() => window.dropHostfsPort());
  const began = Date.now();
  const dropped = await bash('cat /mnt/p/a.txt; echo "cat $?"', { cwd: '/home' });
  assert.ok(Date.now() - began < 15_000, `${Date.now() - began} ms`);
  assert.match(dropped.stdout, /^(over a port\ncat 0|cat 1)\n$/);
  let state = '';
  for (let i = 0; i < 150 && state !== 'ok'; i++) {
    state = (await page.evaluate(() => window.kernel.mounts()))[0].state;
    if (state !== 'ok') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state, 'ok');
  assert.deepEqual(
    await bash('cat /mnt/p/a.txt && echo again > /mnt/p/b.txt && cat /mnt/p/b.txt', {
      cwd: '/home',
    }),
    {
      status: 0,
      stdout: 'over a port\nagain\n',
      stderr: '',
    }
  );
  assert.ok((await page.evaluate(() => window.hostfsPorts.length)) >= 2);
  await page.evaluate(() => window.kernel.umount('/mnt/p'));
  assert.deepEqual(page.errors, []);
});
