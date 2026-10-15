import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

const install = (kernel, name) =>
  installDir(
    kernel,
    fileURLToPath(new URL(`${name}/`, modules)),
    `/node_modules/@ai-ecoverse/${name}`
  );

async function booted(t, users = 'enforce') {
  const kernel = await createNodeKernel({ users });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await installDir(
    kernel,
    fileURLToPath(new URL('fixtures/linktest/', import.meta.url)),
    '/node_modules/linktest'
  );
  await kernel.run(['mkdir', '-p', '/mnt/t'], { cwd: '/' });
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
}

test('ln -L through a symlink on tmpfs links the target', async (t) => {
  const bash = await booted(t);
  const r = await bash(
    'cd /mnt/t && printf hi > orig && ln -s orig sym && ln -L sym hard && stat -c "%i %h %F" orig hard && cat hard'
  );
  assert.equal(r.status, 0, r.stderr);
  const [a, b, body] = r.stdout.trim().split('\n');
  assert.equal(a, b);
  assert.match(a, / 2 regular file$/);
  assert.equal(body, 'hi');
});

test('ln -P of a symlink on tmpfs links the symlink itself', async (t) => {
  const bash = await booted(t);
  const r = await bash(
    'cd /mnt/t && printf hi > orig && ln -s orig sym && ln -P sym hard && stat -c "%F" hard'
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'symbolic link');
});

test('ln -L through a symlink on the OPFS root gives EMLINK', async (t) => {
  const bash = await booted(t);
  const r = await bash('printf x > /a && ln -s a /s && ln -L /s /b');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Too many links/);
});

for (const users of ['enforce', 'off']) {
  test(`a WASI linkat with AT_SYMLINK_FOLLOW through a symlink on tmpfs links the target (users: ${users})`, async (t) => {
    const bash = await booted(t, users);
    const r = await bash(
      'cd /mnt/t && printf hi > orig && ln -s orig sym && linktest sym hard && cat hard'
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, 'file same=1 nlink=2\nhi');
  });
}

test('a WASI linkat with AT_SYMLINK_FOLLOW on the OPFS root gives EPERM', async (t) => {
  const bash = await booted(t);
  const r = await bash('printf x > /a && ln -s a /s && linktest /s /b');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'linkat: Operation not permitted\n');
});
