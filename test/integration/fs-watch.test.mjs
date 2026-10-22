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

async function booted(t, users = 'enforce') {
  const kernel = await createNodeKernel({ users });
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
  const dir = await sh(
    watching('/tmp/w/sub end', 'rm -rf /tmp/gone; mv /tmp/w /tmp/gone; rm -r /tmp/gone')
  );
  assert.deepEqual(lines(dir), ['rename sub', 'ended']);
});

test('a watch follows a rename of a directory above it with no event, and later changes arrive by the old name, as with inotify (#1356, slicc-jsh#441)', async (t) => {
  const { sh } = await booted(t);
  const r = await sh(
    watching('/tmp/w/e end', 'rm -rf /tmp/v; mv /tmp/w /tmp/v; echo 2 >> /tmp/v/e; rm /tmp/v/e')
  );
  assert.deepEqual(lines(r), ['change e', 'rename e', 'ended']);
  const dir = await sh(
    watching('/tmp/w/sub end', 'rm -rf /tmp/v; mv /tmp/w /tmp/v; : > /tmp/v/sub/end')
  );
  assert.deepEqual(lines(dir), ['rename end']);
});

test("a watch follows its root's own rename, which it notes as a moved rename, and only a removal ends it (#1356, slicc-jsh#441)", async (t) => {
  const { sh } = await booted(t);
  const r = await sh(
    watching('/tmp/w/e end', 'mv /tmp/w/e /tmp/w/g; echo 2 >> /tmp/w/g; rm /tmp/w/g')
  );
  assert.deepEqual(lines(r), ['rename e moved', 'change e', 'rename e', 'ended']);
  const over = await sh(watching('/tmp/w/e end', 'echo n > /tmp/w/n; mv /tmp/w/n /tmp/w/e'));
  assert.deepEqual(lines(over), ['rename e', 'ended']);
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

async function watchWhile(t, { args, flags = '', setup = 'mkdir -p /tmp/w', act }) {
  const { kernel, sh } = await booted(t);
  await sh(`rm -rf /tmp/w /tmp/p /tmp/q /tmp/r /tmp/new; ${setup}`);
  const running = sh(`watchtest events ${args} /tmp/r ${flags}`);
  const ready = () =>
    kernel.readFile('/tmp/r').then(
      () => true,
      () => false
    );
  while (!(await ready())) await new Promise((r) => setTimeout(r, 10));
  await act(kernel, sh);
  return lines(await running);
}

test('an embedder writeFile beside a watched directory makes its parents with mkdir -p, which leaves the watch alive and says nothing of the parent (#1047 follow-up)', async (t) => {
  const got = await watchWhile(t, {
    args: '/tmp/w end',
    act: async (kernel) => {
      await kernel.writeFile('/tmp/new', '');
      await kernel.writeFile('/tmp/w/end', '');
    },
  });
  assert.deepEqual(got, ['rename end']);
});

test("a rename of the watched directory's parent leaves the watch on the moved directory (#1047 follow-up, #1356)", async (t) => {
  const got = await watchWhile(t, {
    args: '/tmp/p/w end',
    setup: 'mkdir -p /tmp/p/w',
    act: (_kernel, sh) => sh('mv /tmp/p /tmp/q && : > /tmp/q/w/end'),
  });
  assert.deepEqual(got, ['rename end']);
});

test('an embedder writeFile into a new subtree of a watched directory reports each directory mkdir -p made (#1047 follow-up)', async (t) => {
  const got = await watchWhile(t, {
    args: '/tmp/w n1/n2/f',
    flags: 'recursive',
    act: (kernel) => kernel.writeFile('/tmp/w/n1/n2/f', 'x'),
  });
  assert.deepEqual(got, ['rename n1', 'rename n1/n2', 'rename n1/n2/f']);
});

test('an embedder writeFile in the parent of a watched file leaves that watch alive too (#1047 follow-up)', async (t) => {
  const got = await watchWhile(t, {
    args: '/tmp/fl fl',
    setup: 'rm -f /tmp/fl; echo a > /tmp/fl',
    act: async (kernel) => {
      await kernel.writeFile('/tmp/new', '');
      await kernel.writeFile('/tmp/fl', 'b');
    },
  });
  assert.deepEqual(got, ['change fl']);
});

test('an embedder writeFile over an existing file is a truncate and a write: two changes, as on Linux and as a program write already gives; an empty one only the truncate (#1357)', async (t) => {
  const { kernel, sh } = await booted(t, 'off');
  const bytes = (text) => new TextEncoder().encode(text);
  const seen = async (write) => {
    await kernel.writeFile('/tmp/c/old/o.txt', bytes('o'));
    await sh('rm -f /tmp/r');
    await sh('rm -f /tmp/c/old/end');
    const watching = sh('watchtest rewrite /tmp/c/old o.txt /tmp/r end');
    for (;;) {
      const ready = await kernel.readFile('/tmp/r').then(
        () => true,
        () => false
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await write();
    await kernel.writeFile('/tmp/c/old/end', bytes(''));
    return (await watching).stdout;
  };
  const embedder = (text) => () => kernel.writeFile('/tmp/c/old/o.txt', bytes(text));
  assert.equal(await seen(embedder('oo')), 'change o.txt\nchange o.txt\n');
  assert.equal(await seen(embedder('')), 'change o.txt\n');
  const program = await seen(() => sh('printf oo > /tmp/c/old/o.txt'));
  assert.equal(program, 'change o.txt\nchange o.txt\n');
});

test('every note carries a kernel-wide sequence, so a program can merge its watches back into one queue in operation order, and one event heard by two watches has one number (#1357)', async (t) => {
  const { sh } = await booted(t, 'off');
  const r = await sh(
    'rm -rf /tmp/a /tmp/b; mkdir -p /tmp/a /tmp/b; echo -n 0 > /tmp/a/x; watchtest sequence /tmp/a /tmp/b'
  );
  assert.equal(
    r.stdout,
    [
      'true',
      'A change x',
      'F change x',
      'A change x',
      'F change x',
      'B rename y',
      'B change y',
      'B change y',
      'A change x',
      'F change x',
      'A change x',
      'F change x',
      'A+F A+F A+F A+F',
      '',
    ].join('\n'),
    r.stderr
  );
});
