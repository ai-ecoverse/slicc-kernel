import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { booted, installPackage } from './kernel.mjs';

export const programs = (dir) =>
  [
    'git config --global user.name kernel && git config --global user.email kernel@example.com',
    `cd ${dir} && echo one > a.txt && echo two >> a.txt && printf three > b.txt && echo over > b.txt`,
    'mv b.txt c.txt && mkdir -p d/e && rmdir d/e && echo gone > g.txt && rm g.txt',
    'git init -q && git add . && git commit -qm first && git log --format=%s && git status --porcelain',
    'echo moved > m.txt && mv m.txt /home/m.txt && cat /home/m.txt && ls',
  ].join(' && ');

export async function hostFolder(chrome, t, makeProxy) {
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
