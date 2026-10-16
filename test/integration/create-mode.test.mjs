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

async function enforced(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tar']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const bash = (script, user) => kernel.run(['bash', '-c', script], { cwd: '/work', user });
  await kernel.run(['bash', '-c', 'mkdir -p /work && chown cone:cone /work']);
  return bash;
}

test('a user writes a file it creates without write permission for itself (users: enforce)', async (t) => {
  const bash = await enforced(t);
  const made = await bash('( umask 777; echo made > f ); echo rc=$?; stat -c "%a %U" f', 'cone');
  assert.deepEqual(made, { status: 0, stdout: 'rc=0\n0 cone\n', stderr: '' });
  assert.deepEqual(await bash('cat f'), { status: 0, stdout: 'made\n', stderr: '' });
});

test('cp of a read-only file gives a read-only copy with the same content (users: enforce)', async (t) => {
  const bash = await enforced(t);
  const r = await bash(
    'printf content > ro && chmod 444 ro && cp ro copy && stat -c %a copy && cat copy',
    'cone'
  );
  assert.deepEqual(r, { status: 0, stdout: '444\ncontent', stderr: '' });
});

test('tar extracts a read-only file with its content (users: enforce)', async (t) => {
  const bash = await enforced(t);
  const pack =
    'mkdir -p src && printf packed > src/ro && chmod 444 src/ro && tar cf a.tar src && rm -rf src';
  assert.equal((await bash(pack, 'cone')).status, 0);
  const r = await bash(
    'mkdir out && tar xf a.tar -C out && stat -c %a out/src/ro && cat out/src/ro',
    'cone'
  );
  assert.deepEqual(r, { status: 0, stdout: '444\npacked', stderr: '' });
});

const CHMOD_AS_OTHER = `import os
fd = os.open('/work/mine', os.O_RDONLY)
for name, op in (('path', lambda m: os.chmod('/work/mine', m)), ('fd', lambda m: os.fchmod(fd, m))):
    for m in (0o644, 0o600):
        try:
            op(m)
            print(name, oct(m), 'ok')
        except PermissionError:
            print(name, oct(m), 'EPERM')
`;

test('chmod and fchmod by a user who does not own the file fail with EPERM, also to the mode it already has (users: enforce)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const made = await kernel.run(
    [
      'bash',
      '-c',
      'mkdir -p /work && chmod 777 /work && printf x > /work/mine && chmod 644 /work/mine',
    ],
    { cwd: '/' }
  );
  assert.equal(made.status, 0);
  const r = await kernel.run(['python3', '-c', CHMOD_AS_OTHER], { cwd: '/', user: 'cone' });
  assert.deepEqual(r, {
    status: 0,
    stdout: 'path 0o644 EPERM\npath 0o600 EPERM\nfd 0o644 EPERM\nfd 0o600 EPERM\n',
    stderr: '',
  });
  const mode = await kernel.run(['bash', '-c', 'stat -c %a /work/mine'], { cwd: '/' });
  assert.equal(mode.stdout, '644\n');
});
