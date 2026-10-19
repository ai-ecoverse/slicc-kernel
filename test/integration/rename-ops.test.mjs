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

const N = 60;
const LOOKUPS = "int(open('/proc/sys/kernel/slicc_opfs_calls').read())";

test('renaming a written file costs 3 OPFS lookups, not 5, and a file with an explicit mtime keeps it (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  await sh('mkdir -p /tmp/ro');
  const r = await sh(
    py([
      `for i in range(${N}):`,
      "  fd = os.open(f'/tmp/ro/f{i}', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o644)",
      "  os.write(fd, b'x' * 4096)",
      '  os.close(fd)',
      "os.utime('/tmp/ro/f0', (1500000000, 1500000000))",
      'b, quiet = None, 0',
      'while quiet < 10:',
      `  c = ${LOOKUPS}`,
      '  quiet = quiet + 1 if c == b else 0',
      '  b = c',
      '  time.sleep(0.05)',
      `a = ${LOOKUPS}`,
      `for i in range(${N}):`,
      "  os.rename(f'/tmp/ro/f{i}', f'/tmp/ro/g{i}')",
      `print(${LOOKUPS} - a, int(os.stat('/tmp/ro/g0').st_mtime))`,
    ])
  );
  assert.equal(r.status, 0, r.stderr);
  const [lookups, mtime] = r.stdout.trim().split(' ').map(Number);
  console.log(`OPFS lookups per rename: ${(lookups / N).toFixed(2)}`);
  assert.equal(mtime, 1500000000);
  assert.ok(lookups / N <= 3.5, `${lookups / N} OPFS lookups per rename`);
});
