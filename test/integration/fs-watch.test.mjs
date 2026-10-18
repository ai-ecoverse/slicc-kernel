import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/watchtest/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  for (const file of ['package.json', 'bin/watchtest.mjs']) {
    await kernel.writeFile(
      `/node_modules/watchtest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  const sh = (script, user) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
  return { kernel, sh };
}

const lines = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .trim()
    .split('\n')
    .filter((line, i, all) => line !== all[i - 1]);
};

const watching = (args, then, flags = '') =>
  `rm -rf /tmp/w /tmp/r; mkdir -p /tmp/w/sub; echo old > /tmp/w/e; watchtest events ${args} /tmp/r ${flags} & until [ -e /tmp/r ]; do :; done; ${then}; wait`;

test("ctx.fs.watch on a directory reports its entries' renames and changes by name, in order (#1031)", async (t) => {
  const { sh } = await booted(t);
  const r = await sh(
    watching(
      '/tmp/w end',
      'echo a > /tmp/w/a; echo more >> /tmp/w/e; chmod 600 /tmp/w/e; mv /tmp/w/a /tmp/w/b; rm /tmp/w/b; echo deep > /tmp/w/sub/x; mkdir /tmp/w/d; touch /tmp/w/end'
    )
  );
  assert.deepEqual(lines(r), [
    'rename a',
    'change a',
    'change e',
    'rename a',
    'rename b',
    'rename d',
    'rename end',
  ]);
});

test('ctx.sync.fs.watch is in place when it returns, and a recursive watch names entries below by relative path (#1031)', async (t) => {
  const { sh } = await booted(t);
  const r = await sh(
    watching(
      '/tmp/w sub/end',
      'echo a > /tmp/w/sub/x; rm /tmp/w/e; touch /tmp/w/sub/end',
      'recursive sync'
    )
  );
  assert.deepEqual(lines(r), ['rename sub/x', 'change sub/x', 'rename e', 'rename sub/end']);
});

test('a file watch reports its changes by basename, then one rename when the file goes, and ends (#1031)', async (t) => {
  const { sh } = await booted(t);
  const r = await sh(watching('/tmp/w/e end', 'echo y >> /tmp/w/e; rm /tmp/w/e'));
  assert.deepEqual(lines(r), ['change e', 'rename e', 'ended']);
  const dir = await sh(watching('/tmp/w/sub end', 'mv /tmp/w /tmp/gone'));
  assert.deepEqual(lines(dir), ['rename sub', 'ended']);
});

test('the embedder and a tmpfs mount count as writers (#1031)', async (t) => {
  const { kernel, sh } = await booted(t);
  await sh('mkdir -p /mnt/t /tmp/w');
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  const embedded = sh('watchtest events /tmp/w end /tmp/r1');
  for (;;) {
    const ready = await kernel.readFile('/tmp/r1').then(
      () => true,
      () => false
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await kernel.writeFile('/tmp/w/k', 'from the embedder');
  await kernel.writeFile('/tmp/w/end', '');
  assert.deepEqual(lines(await embedded), ['rename k', 'change k', 'rename end']);
  const mounted = await sh(
    'watchtest events /mnt/t end /tmp/r2 & until [ -e /tmp/r2 ]; do :; done; echo t > /mnt/t/m; touch /mnt/t/end; wait'
  );
  assert.deepEqual(lines(mounted), ['rename m', 'change m', 'rename end']);
});

test('watching a missing path is ENOENT and an unreadable one EACCES; close() twice is fine and nothing comes after it; a watch keeps no program alive (#1031)', async (t) => {
  const { kernel, sh } = await booted(t);
  assert.deepEqual(lines(await sh('watchtest refused /tmp/none')), ['ENOENT']);
  await kernel.users.add({ name: 'cone' });
  await sh('mkdir -p /tmp/locked && chmod 700 /tmp/locked');
  assert.deepEqual(lines(await sh('watchtest refused /tmp/locked', 'cone')), ['EACCES']);
  assert.deepEqual(lines(await sh('mkdir -p /tmp/c && watchtest closed /tmp/c')), ['0']);
  assert.deepEqual(lines(await sh('mkdir -p /tmp/l && watchtest leave /tmp/l')), ['left']);
});

test('more changes than a watch holds between reads come as an overflow note after the ones kept (#1031)', async (t) => {
  const { sh } = await booted(t);
  assert.deepEqual(lines(await sh('mkdir -p /tmp/f && watchtest flood /tmp/f 1200')), [
    'true true',
  ]);
});
