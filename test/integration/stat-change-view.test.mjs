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

test("a WASI program busy-polling stat sees another process's append within its loop, and a pread sized by that stat gets all of it (#1026)", {
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
      'now = was',
      'for i in range(100000):',
      "  now = os.stat('f').st_size",
      '  if now != was:',
      '    break',
      "fd = os.open('f', os.O_RDONLY)",
      'print(was, now, len(os.pread(fd, now, 0)))',
    ])
  );
  const writer = await sh('until [ -e ready ]; do :; done; printf bb >> f; touch done');
  assert.deepEqual(writer, { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(await watcher, { status: 0, stdout: '2 4 4\n', stderr: '' });
});
