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

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(['import os', ...lines].join('\n')).toString('base64')} | base64 -d)"`;

test("a WASI program that keeps stat-ing a file sees another process's append at its next stat and a read sized by a stat gets all of it, without sleeping in between (#1026)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp/cv' });
  await kernel.run(['mkdir', '-p', '/tmp/cv'], { cwd: '/' });
  await sh('printf aa > f');
  const watcher = sh(
    py([
      "was = os.stat('f').st_size",
      "open('ready', 'w').close()",
      "while not os.path.exists('done'):",
      '  pass',
      "now = os.stat('f').st_size",
      "fd = os.open('f', os.O_RDONLY)",
      "print(was, now, len(os.read(fd, os.stat('f').st_size)))",
    ])
  );
  const writer = await sh('until [ -e ready ]; do :; done; printf bb >> f; touch done');
  assert.deepEqual(writer, { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(await watcher, { status: 0, stdout: '2 4 4\n', stderr: '' });
});
