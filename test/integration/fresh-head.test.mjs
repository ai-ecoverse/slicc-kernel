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

test('a file a WASI program creates and writes from its start is not read back to see whether it is a wasm module, and one that is becomes executable (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  await sh('mkdir -p /tmp/fh');
  const r = await sh(
    py([
      'least = None',
      'for r in range(5):',
      `  a = ${LOOKUPS}`,
      `  for i in range(${N}):`,
      "    fd = os.open(f'/tmp/fh/f{r}_{i}', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o644)",
      "    os.write(fd, b'x' * 4096)",
      '    os.close(fd)',
      '  b, quiet = None, 0',
      '  while quiet < 10:',
      `    c = ${LOOKUPS}`,
      '    quiet = quiet + 1 if c == b else 0',
      '    b = c',
      '    time.sleep(0.05)',
      '  least = b - a if least is None else min(least, b - a)',
      'print(least)',
    ])
  );
  assert.equal(r.status, 0, r.stderr);
  const per = Number(r.stdout) / N;
  const seen = [`O_EXCL + write ${per.toFixed(2)}`];
  assert.ok(per <= 4.5, `${per} OPFS lookups per file`);
  console.log(`OPFS lookups per created and written file: ${seen.join(', ')}`);
  const made = await sh(
    `${py([
      "fd = os.open('/tmp/fh/mod.wasm', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o666)",
      'os.write(fd, bytes([0, 97, 115, 109, 1, 0, 0, 0]) + bytes(64))',
      'os.close(fd)',
      "fd = os.open('/tmp/fh/text', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o666)",
      "os.write(fd, b'not a module')",
      'os.close(fd)',
    ])}; stat -c '%a %n' /tmp/fh/mod.wasm /tmp/fh/text`
  );
  assert.deepEqual(made, {
    status: 0,
    stdout: '755 /tmp/fh/mod.wasm\n644 /tmp/fh/text\n',
    stderr: '',
  });
});
