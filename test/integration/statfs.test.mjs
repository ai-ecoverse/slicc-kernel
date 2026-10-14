import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

test('JS programs get statfs from the kernel: the root, a tmpfs mount, and ENOENT', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    await installDir(
      kernel,
      fileURLToPath(new URL(`${name}/`, modules)),
      `/node_modules/@ai-ecoverse/${name}`
    );
  }
  await installDir(
    kernel,
    fileURLToPath(new URL('fixtures/statfstest/', import.meta.url)),
    '/node_modules/statfstest'
  );
  await kernel.writeFile('/mnt/t/.keep', '');
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  await kernel.writeFile('/mnt/t/f', 'x'.repeat(10000));
  const r = await kernel.run(['statfstest', '/', '/mnt/t', '/mnt/t/f', '/nope'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  const counts = { type: 0, bsize: 4096, files: 0, ffree: 0 };
  const zero = { ...counts, blocks: 0, bfree: 0, bavail: 0, quota: 0, usage: 0 };
  assert.deepEqual(got['/'], { async: zero, sync: zero });
  const tmpfs = { ...counts, blocks: 262144, bfree: 262144, bavail: 262144 };
  Object.assign(tmpfs, { quota: 262144 * 4096, usage: 0 });
  assert.deepEqual(got['/mnt/t'], { async: tmpfs, sync: tmpfs });
  assert.deepEqual(got['/mnt/t/f'], { async: tmpfs, sync: tmpfs });
  assert.deepEqual(got['/nope'], { error: 'ENOENT' });
  const df = await kernel.run(['bash', '-c', "stat -f -c '%S %b %f' /mnt/t"], { cwd: '/' });
  assert.equal(df.stdout, '4096 262144 262144\n', df.stderr);
});
