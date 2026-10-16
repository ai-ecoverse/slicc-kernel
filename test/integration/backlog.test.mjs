import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('./fixtures/backlogtest/', import.meta.url);
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

async function kernelWith(t) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/backlogtest.wasm']) {
    await kernel.writeFile(
      `/node_modules/backlogtest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  return kernel;
}

test('a loopback connect to a listener whose backlog is full waits for a slot instead of ECONNREFUSED (#759)', {
  timeout: 60_000,
}, async (t) => {
  const kernel = await kernelWith(t);
  assert.deepEqual(await kernel.run(['backlogtest', 'nonblocking', '20'], { cwd: '/' }), {
    status: 0,
    stdout: 'connects: 20 in progress, 0 refused\nserved 20 of 20\n',
    stderr: '',
  });
  await install(kernel, 'wasm-bash');
  assert.deepEqual(
    await kernel.run(
      ['bash', '-c', 'backlogtest serve 7400 10 & backlogtest clients 7400 10; wait'],
      { cwd: '/' }
    ),
    { status: 0, stdout: 'listening\nblocking connects 10 of 10 echoed\n', stderr: '' }
  );
});
