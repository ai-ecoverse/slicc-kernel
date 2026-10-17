import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

test('a name found missing and then made, by this process or another, is there at once, with its mode and owner (users: enforce, #774)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  await kernel.run(['bash', '-c', 'mkdir -p /work && chmod 1777 /work'], { cwd: '/' });
  const script = [
    'cd /work',
    'for i in 1 2 3; do test -e f$i || ( umask 027; : > f$i ); stat -c "%n %a %U" f$i; done',
    'test -e g || ( : > g ); stat -c "%n %a %U" g',
    'test -e d || mkdir d; stat -c "%n %F" d',
    'test -e l || ln -s f1 l; stat -c "%n %F" l',
    'for i in 1 2 3 4 5 6; do ( set -C; : > x$i ) 2>/dev/null & ( set -C; : > x$i ) 2>/dev/null & wait; done; ls x* | wc -l',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', script], { cwd: '/', user: 'cone' });
  assert.deepEqual(r, {
    status: 0,
    stdout: 'f1 640 cone\nf2 640 cone\nf3 640 cone\ng 644 cone\nd directory\nl symbolic link\n6\n',
    stderr: '',
  });
});
