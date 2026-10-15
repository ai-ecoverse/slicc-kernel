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

test('a tmpfs mount keeps the access time apart from the modification time (#617)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.run(['mkdir', '-p', '/mnt/t'], { cwd: '/' });
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  const script = [
    'cd /mnt/t && printf x > f',
    'touch -a -d @1000000 f && touch -m -d @2000000 f && stat -c "%X %Y" f',
    'touch -a -d @3000000 f && stat -c "%X %Y" f',
    'cat f >/dev/null && stat -c "%X %Y" f',
  ].join(' && ');
  const r = await kernel.run(['bash', '-c', script], { cwd: '/' });
  assert.deepEqual(r, {
    status: 0,
    stdout: '1000000 2000000\n3000000 2000000\n3000000 2000000\n',
    stderr: '',
  });
});
