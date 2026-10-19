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
  `python3 -c "$(echo ${Buffer.from(['import os, time', ...lines].join('\n')).toString('base64')} | base64 -d)"`;

const N = 40;
const KNOWN =
  "[int(open(f'/proc/sys/kernel/{n}').read()) if os.path.exists(f'/proc/sys/kernel/{n}') else 0 for n in ('slicc_opfs_calls', 'slicc_opfs_ops')]";

test('reading a file on the OPFS root takes the file the lookup just got: 1 OPFS lookup and 1 request per file, not 2 requests (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const r = await kernel.run(
    [
      'bash',
      '-c',
      py([
        "os.makedirs('/tmp/pr', exist_ok=True)",
        `for i in range(${N}): open(f'/tmp/pr/f{i}', 'wb').write(os.urandom(20000))`,
        'b, quiet = None, 0',
        'while quiet < 10:',
        `  c = ${KNOWN}`,
        '  quiet = quiet + 1 if c == b else 0',
        '  b = c',
        '  time.sleep(0.05)',
        `a = ${KNOWN}`,
        `for i in range(${N}):`,
        "  fd = os.open(f'/tmp/pr/f{i}', os.O_RDONLY)",
        '  assert len(os.read(fd, 20000)) == 20000',
        '  os.close(fd)',
        `b = ${KNOWN}`,
        "print(' '.join(str(y - x) for x, y in zip(a, b)))",
      ]),
    ],
    { cwd: '/' }
  );
  assert.equal(r.status, 0, r.stderr);
  const [lookups, requests] = r.stdout
    .trim()
    .split(' ')
    .map((v) => Number(v) / N);
  console.log(`per read file: ${lookups.toFixed(2)} OPFS lookups, ${requests.toFixed(2)} requests`);
  assert.ok(requests >= 1, `${requests} OPFS requests per read file`);
  assert.ok(requests <= 1.5, `${requests} OPFS requests per read file`);
});
