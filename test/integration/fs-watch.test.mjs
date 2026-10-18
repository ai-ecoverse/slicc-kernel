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

test("a user's recursive watch sees nothing inside another user's 0700 directory until it is opened up, and a path under an unsearchable directory is EACCES whether or not it exists (#1031)", async (t) => {
  const { kernel, sh } = await booted(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.users.add({ name: 'bee' });
  await sh(
    'mkdir -p /tmp/s && chmod 777 /tmp/s && rm -f /tmp/s1 /tmp/s2 && touch /root/.profile && chmod 700 /root'
  );
  await sh('mkdir /tmp/s/b && chmod 700 /tmp/s/b', 'bee');
  const watch = (ready, then) =>
    sh(
      `watchtest events /tmp/s end /tmp/${ready} recursive > /tmp/${ready}.out & until [ -e /tmp/${ready} ]; do :; done; ${then}; wait; cat /tmp/${ready}.out`,
      'cone'
    );
  const hidden = watch('s1', 'true');
  for (;;) {
    const ready = await kernel.readFile('/tmp/s1').then(
      () => true,
      () => false
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await sh('echo x > /tmp/s/b/x && touch /tmp/s/end', 'bee');
  assert.deepEqual(lines(await hidden), ['rename end']);
  await sh('rm /tmp/s/end && chmod 755 /tmp/s/b', 'bee');
  const shown = watch('s2', 'true');
  for (;;) {
    const ready = await kernel.readFile('/tmp/s2').then(
      () => true,
      () => false
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await sh('echo y > /tmp/s/b/y && touch /tmp/s/end', 'bee');
  assert.deepEqual(lines(await shown), ['rename b/y', 'change b/y', 'rename end']);
  assert.deepEqual(lines(await sh('watchtest refused /root/nope', 'cone')), ['EACCES']);
  assert.deepEqual(lines(await sh('watchtest refused /root/.profile', 'cone')), ['EACCES']);
});

test('a watch through a symlink to a directory hears operations made through either name (#1031)', async (t) => {
  const { sh } = await booted(t);
  const r = await sh(
    'rm -rf /tmp/real /tmp/alias /tmp/ra; mkdir /tmp/real; ln -s /tmp/real /tmp/alias; watchtest events /tmp/alias end /tmp/ra & until [ -e /tmp/ra ]; do :; done; mkdir /tmp/alias/viaalias; mkdir /tmp/real/viareal; touch /tmp/alias/end; wait'
  );
  assert.deepEqual(lines(r), ['rename viaalias', 'rename viareal', 'rename end']);
});
