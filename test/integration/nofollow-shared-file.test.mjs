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

test('a no-follow open of a file this process already has open shares its data: writes through either fd land, and reads see them', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile('/w/g', 'old');
  const r = await kernel.run(
    [
      'bash',
      '-c',
      py([
        "a = os.open('f', os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o644); os.write(a, b'hello world')",
        "b = os.open('f', os.O_RDWR | os.O_NOFOLLOW); os.lseek(b, 6, 0); os.write(b, b'WORLD')",
        'os.close(b); os.close(a)',
        "print(open('f', 'rb').read())",
        "c = os.open('g', os.O_RDWR); os.write(c, b'new')",
        "d = os.open('g', os.O_RDONLY | os.O_NOFOLLOW); print(os.read(d, 8)); os.close(d); os.close(c)",
      ]),
    ],
    { cwd: '/w' }
  );
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "b'hello WORLD'\nb'new'\n", '']);
});
