import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/forkrelocs/', import.meta.url);

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/forkrelocs.wasm']) {
    await kernel.writeFile(
      `/node_modules/forkrelocs/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  await kernel.writeFile(
    '/usr/lib/libforkrelocs.so',
    await readFile(new URL('lib/libforkrelocs.so', fixture))
  );
  return kernel;
}

test('a forked child of a position-independent WASIX program keeps the pointers its parent changed: no second data relocation (#777)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['forkrelocs'], { cwd: '/' }), {
    status: 0,
    stdout: 'child: p &b (kept)\n',
    stderr: '',
  });
});

test('a forked child keeps the pointers its parent changed in a side module it loaded (#777)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['forkrelocs', '/usr/lib/libforkrelocs.so'], { cwd: '/' }), {
    status: 0,
    stdout: 'child: p &b (kept), side pointer kept\n',
    stderr: '',
  });
});
