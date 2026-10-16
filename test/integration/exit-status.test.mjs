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

test('a WASIX exit(-1) or exit(263) is status 255 or 7 for kernel.run, openTerminal and the parent shell (#758)', async (t) => {
  const kernel = await createNodeKernel({});
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  for (const [code, status] of [
    [-1, 255],
    [263, 7],
    [3, 3],
  ]) {
    const argv = ['python3', '-c', `import os; os._exit(${code})`];
    assert.equal((await kernel.run(argv, { cwd: '/' })).status, status, `run ${code}`);
    const term = await kernel.openTerminal(argv, { cwd: '/', onData() {} });
    assert.equal(await term.exited, status, `openTerminal ${code}`);
    const shell = await kernel.run(['bash', '-c', `${argv[0]} -c '${argv[2]}'; echo $?`], {
      cwd: '/',
    });
    assert.equal(shell.stdout, `${status}\n`, `bash ${code}`);
  }
});
