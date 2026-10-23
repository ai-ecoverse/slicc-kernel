import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/jstest/', import.meta.url);

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

test("readInto works on a JS program's device, /proc and FIFO files, async and sync (#1479)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  for (const file of ['package.json', 'bin/jstest.mjs']) {
    await kernel.writeFile(`/node_modules/jstest/${file}`, await readFile(new URL(file, fixture)));
  }
  const r = await kernel.run(
    [
      'bash',
      '-c',
      'rm -rf /tmp/ri && mkdir -p /tmp/ri && mkfifo /tmp/ri/p && jstest readintoall /tmp/ri',
    ],
    { cwd: '/' }
  );
  assert.deepEqual(r, {
    status: 0,
    stdout: [
      'dev 4 77000077',
      'sync dev 2 77777700',
      'proc 4 true',
      'sync proc 2',
      'sync proc small EINVAL',
      'fifo 3 .abc..',
      'fifo seek ESPIPE',
      '',
    ].join('\n'),
    stderr: '',
  });
});
