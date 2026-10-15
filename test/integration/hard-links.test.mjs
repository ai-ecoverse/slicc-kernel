import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

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
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tar']) await install(kernel, name);
  if (users !== 'off') {
    await kernel.users.add({ name: 'alice' });
    await kernel.users.add({ name: 'bob' });
  }
  await kernel.run(['mkdir', '-p', '/mnt/t'], { cwd: '/' });
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  return (script, user) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
}

const lines = (r) => r.stdout.trim().split('\n');

test('ln makes a real hard link on tmpfs: one inode, nlink 2, writes shared (users: enforce)', async (t) => {
  const bash = await booted(t);
  const r = await bash(
    'printf hello > /mnt/t/orig && ln /mnt/t/orig /mnt/t/link && stat -c "%i %h" /mnt/t/orig /mnt/t/link && printf world >> /mnt/t/link && cat /mnt/t/orig'
  );
  assert.equal(r.status, 0, r.stderr);
  const [a, b, body] = lines(r);
  assert.equal(a, b);
  assert.equal(a.split(' ')[1], '2');
  assert.equal(body, 'helloworld');
});

for (const users of ['enforce', 'off']) {
  test(`ln on the OPFS root gives EMLINK (users: ${users})`, async (t) => {
    const bash = await booted(t, users);
    const r = await bash('printf x > /a; ln /a /b');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Too many links/);
  });
}

test('ln across mounts gives EXDEV (users: enforce)', async (t) => {
  const bash = await booted(t);
  const r = await bash('printf x > /mnt/t/src; ln /mnt/t/src /cross');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Cross-device link/);
});

test('protected hard links under enforce: who may link whose file', async (t) => {
  const bash = await booted(t);
  const setup = [
    'chmod 1777 /mnt/t',
    'printf s > /mnt/t/owned && chown alice:alice /mnt/t/owned && chmod 600 /mnt/t/owned',
    'printf m > /mnt/t/bfile && chown bob:bob /mnt/t/bfile && chmod 600 /mnt/t/bfile',
    'printf o > /mnt/t/aopen && chown alice:alice /mnt/t/aopen && chmod 666 /mnt/t/aopen',
  ].join(' && ');
  assert.equal((await bash(setup)).status, 0);
  const stolen = await bash('ln /mnt/t/owned /mnt/t/stolen', 'bob');
  assert.notEqual(stolen.status, 0);
  assert.match(stolen.stderr, /Operation not permitted/);
  const own = await bash('ln /mnt/t/bfile /mnt/t/blink && stat -c %h /mnt/t/blink', 'bob');
  assert.deepEqual(lines(own), ['2'], own.stderr);
  const open = await bash('ln /mnt/t/aopen /mnt/t/bopen && stat -c %h /mnt/t/bopen', 'bob');
  assert.deepEqual(lines(open), ['2'], open.stderr);
  const root = await bash('ln /mnt/t/owned /mnt/t/rootlink && stat -c %h /mnt/t/rootlink');
  assert.deepEqual(lines(root), ['2'], root.stderr);
});

const PACK = 'cd /mnt/t && mkdir src && printf hi > src/a && ln src/a src/b && tar cf l.tar src';

test('tar cf stores the second name of a linked file as a link member (users: enforce)', async (t) => {
  const bash = await booted(t);
  const r = await bash(`${PACK} && tar tvf l.tar`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^-rw-r--r-- root\/root +2 .* src\/a$/m);
  assert.match(r.stdout, /^hrw-r--r-- root\/root +0 .* src\/b link to src\/a$/m);
});

test('tar xf of a link member on tmpfs makes a real hard link, as root and as a user', async (t) => {
  const bash = await booted(t);
  const setup = `${PACK} && mkdir -p /mnt/t/out /mnt/t/mine && chown alice /mnt/t/mine`;
  assert.equal((await bash(setup)).status, 0);
  for (const [dir, user] of [
    ['/mnt/t/out', undefined],
    ['/mnt/t/mine', 'alice'],
  ]) {
    const r = await bash(
      `tar xf /mnt/t/l.tar -C ${dir} && stat -c "%i %h" ${dir}/src/a ${dir}/src/b && cat ${dir}/src/b`,
      user
    );
    assert.equal(r.status, 0, `${dir}: ${r.stderr}`);
    const [a, b, body] = r.stdout.split('\n');
    assert.equal(a, b);
    assert.equal(a.split(' ')[1], '2');
    assert.equal(body, 'hi');
  }
});

test('tar xf into the OPFS root reports EMLINK for the link member and makes no copy', async (t) => {
  const bash = await booted(t);
  assert.equal((await bash(PACK)).status, 0);
  const r = await bash(
    'mkdir /rootout && tar xf /mnt/t/l.tar -C /rootout; echo rc=$?; cat /rootout/src/a; ls /rootout/src'
  );
  assert.equal(r.stdout, 'rc=2\nhia\n');
  assert.match(r.stderr, /src\/b: Cannot hard link to .src\/a.: Too many links/);
});
