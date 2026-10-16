import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

const PY = [
  'import os, subprocess, time',
  'probe = lambda p: (os.path.exists(p), os.path.islink(p))',
  "print('before', probe('/tmp/nd'), probe('/tmp/nd/a/b'), probe('/tmp/nd/a'))",
  "subprocess.run(['bash', '-c', 'mkdir -p /tmp/nd/a && printf xyz > /tmp/nd/a/b && ln -s b /tmp/nd/a/l'])",
  "print('after', probe('/tmp/nd/a/b'), os.stat('/tmp/nd/a/b').st_size, os.readlink('/tmp/nd/a/l'))",
  "print('api', os.path.exists('/tmp/api'), flush=True)",
  "open('/tmp/asked', 'w').close()",
  'for _ in range(400):',
  "    if os.path.exists('/tmp/api'): break",
  '    time.sleep(0.01)',
  "print('api', os.path.exists('/tmp/api'))",
  "try:\n    os.readlink('/tmp/nd/a/b')\nexcept OSError as e:\n    print('readlink', e.strerror)",
  "os.lstat('/tmp/nd/a/b')",
  "print('relink', flush=True)",
  'for _ in range(400):',
  "    if os.path.exists('/tmp/relinked'): break",
  '    time.sleep(0.01)',
  "try:\n    print('relinked', os.readlink('/tmp/nd/a/b'))\nexcept OSError as e:\n    print('relinked', e.strerror)",
].join('\n');

test('a WASI program sees names another process or the kernel API creates under paths it found missing, at once (#774)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const relink = Promise.withResolvers();
  const run = kernel.run(['python3', '-c', PY], {
    cwd: '/tmp',
    onStdout: (text) => {
      if (text.includes('relink\n')) relink.resolve();
    },
  });
  for (let i = 0; i < 600; i++) {
    const asked = await kernel.readFile('/tmp/asked').then(
      () => true,
      () => false
    );
    if (asked) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await kernel.writeFile('/tmp/api', 'k');
  await relink.promise;
  await kernel.run(['bash', '-c', 'rm /tmp/nd/a/b && ln -s l /tmp/nd/a/b'], { cwd: '/' });
  await kernel.writeFile('/tmp/relinked', '');
  const r = await run;
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    [
      'before (False, False) (False, False) (False, False)',
      'after (True, False) 3 b',
      'api False',
      'api True',
      'readlink Invalid argument',
      'relink',
      'relinked l',
      '',
    ].join('\n')
  );
});
