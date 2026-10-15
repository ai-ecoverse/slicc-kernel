import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/dlfork/', import.meta.url);

async function install(kernel, base, at) {
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(fileURLToPath(base), file)}`, await readFile(file));
  }
}

test('a forked WASIX child keeps the side modules its parent loaded, their data and function pointers (#337)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await install(kernel, fixture, '/node_modules/dlfork');
  await kernel.writeFile(
    '/usr/lib/libdlside.so',
    await readFile(new URL('lib/libdlside.so', fixture))
  );
  assert.deepEqual(await kernel.run(['dlfork'], { cwd: '/' }), {
    status: 0,
    stdout:
      'parent: add=47 count=42 inits=1\nchild: add=48 count=42 bump=43 inits=1\nparent: child exit=7 count=42\n',
    stderr: '',
  });
});
