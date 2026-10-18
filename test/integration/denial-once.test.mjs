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

test('a refused truncating open is refused once: one denial per open, the same EACCES (#1020)', {
  timeout: 300_000,
}, async (t) => {
  const denials = [];
  const kernel = await createNodeKernel({ users: 'enforce', onDenial: (d) => denials.push(d) });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const as = async (script) => {
    const r = await kernel.run(['bash', '-c', script], { cwd: '/tmp', user: 'cone' });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  const r = await as(
    'echo gap > /root/f; echo rc=$?; echo more | tee /root/g > /dev/null; echo rc=$?'
  );
  assert.equal(r.stdout, 'rc=1\nrc=1\n', r.stderr);
  assert.deepEqual(
    denials.map((d) => [d.op, d.path, d.uid]),
    [
      ['lstat', '/root/f', 1000],
      ['lstat', '/root/g', 1000],
    ]
  );
});
