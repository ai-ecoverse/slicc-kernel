import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/eflocktest/', import.meta.url);

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

test("an Emscripten program's flock() reaches the kernel through __syscall_flock: a second process's LOCK_NB is EWOULDBLOCK while the first holds LOCK_EX (#947)", {
  timeout: 60_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/eflocktest/package.json',
    await readFile(new URL('package.json', fixture))
  );
  for (const file of ['bin/eflocktest', 'bin/eflocktest.wasm']) {
    await kernel.writeFile(
      `/node_modules/eflocktest/${file}`,
      await readFile(new URL(file, fixture)),
      {
        mode: 0o755,
      }
    );
  }
  const r = await kernel.run(
    [
      'bash',
      '-c',
      [
        '{ sleep 1; } | eflocktest hold /tmp/l > /tmp/held &',
        'until [ -s /tmp/held ]; do sleep 0.05; done',
        'eflocktest try /tmp/l',
        'eflocktest shared /tmp/l',
        'wait',
        'cat /tmp/held',
        'eflocktest try /tmp/l',
      ].join('\n'),
    ],
    { cwd: '/' }
  );
  assert.deepEqual(r, {
    status: 0,
    stdout: [
      'LOCK_EX|LOCK_NB: Resource temporarily unavailable',
      'LOCK_SH|LOCK_NB: Resource temporarily unavailable',
      'held',
      'LOCK_UN: ok',
      'LOCK_EX|LOCK_NB: ok',
      '',
    ].join('\n'),
    stderr: '',
  });
});
