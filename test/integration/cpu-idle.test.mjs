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

const PROGRAM = `
import json, os, select, time
def cpu():
    f = open('/proc/self/stat').read().rsplit(') ', 1)[1].split()
    return int(f[11]), int(f[12])
pid = os.posix_spawn('/usr/bin/sleep', ['sleep', '30'], os.environ)
u0, s0 = cpu()
t0 = time.monotonic()
while time.monotonic() - t0 < 1.0:
    os.waitpid(pid, os.WNOHANG)
    select.select([], [], [], 0)
busy = time.monotonic() - t0
u1, s1 = cpu()
select.select([], [], [], 1.0)
u2, s2 = cpu()
os.kill(pid, 9)
os.waitpid(pid, 0)
print(json.dumps({'busy': (u1 - u0 + s1 - s0) / (busy * 100), 'stime': s1 - s0, 'waited': u2 - u1 + s2 - s1}))
`;

test('a loop of calls that return at once counts as CPU time, a wait that really blocks does not (#427)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-coreutils');
  await install(kernel, 'wasix-python');
  const r = await kernel.run(['python3', '-c', PROGRAM], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  const { busy, stime, waited } = JSON.parse(r.stdout);
  assert.ok(busy > 0.9, `busy loop counted ${busy} of its wall time`);
  assert.ok(stime > 0, `busy loop has stime ${stime}`);
  assert.ok(waited <= 10, `a 1 s select counted ${waited} ticks`);
});
