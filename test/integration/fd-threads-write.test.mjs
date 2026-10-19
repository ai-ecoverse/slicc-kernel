import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/fdrace/', import.meta.url);

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

const ROUNDS = 5;

for (const mode of ['shared', 'append']) {
  test(`four threads writing records to one fd (${mode === 'append' ? 'O_APPEND' : 'one shared offset'}) leave every record exactly once, none torn (homescoop#1127)`, {
    timeout: 300_000,
  }, async (t) => {
    const kernel = await createNodeKernel({ users: 'enforce' });
    t.after(() => kernel.terminate());
    await install(kernel, 'wasm-bash');
    for (const file of ['package.json', 'bin/fdrace.wasm']) {
      await kernel.writeFile(
        `/node_modules/fdrace/${file}`,
        await readFile(new URL(file, fixture))
      );
    }
    for (let round = 0; round < ROUNDS; round++) {
      const r = await kernel.run(['fdrace', `/tmp/fdrace-${mode}`, mode], { cwd: '/' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'records 4000 torn 0 dup 0 missing 0 size 64000\n', `round ${round}`);
    }
  });
}
