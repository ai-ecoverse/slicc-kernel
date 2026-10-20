import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('fixtures/deeptest/', import.meta.url);

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

test("a wasm program that overflows the JS stack reports it on its own fd 2, so 2> catches it and the session's stderr stays clean (#1237, homescoop#1021)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  for (const file of ['package.json', 'bin/deeptest.wasm']) {
    await kernel.writeFile(
      `/node_modules/deeptest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  const r = await kernel.run(
    ['bash', '-c', 'deeptest >/dev/null 2>/tmp/e; echo "rc=$?"; cat /tmp/e'],
    { cwd: '/' }
  );
  assert.equal(r.stderr, '', "nothing reaches the session's stderr");
  assert.match(r.stdout, /^rc=70\n/);
  assert.match(r.stdout, /Maximum call stack size exceeded/);
});
