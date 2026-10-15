import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = (name) => fileURLToPath(new URL(`fixtures/${name}/`, import.meta.url));

const chain = (dir, n, end) =>
  `mkdir -p ${dir} && for i in $(seq 0 ${n - 2}); do ln -s ${dir}/l$((i + 1)) ${dir}/l$i; done && ln -s ${end} ${dir}/l${n - 1}`;

const setup = ['mkdir -p /end/sub && printf E > /end/f'];
const rows = [];
for (const n of [39, 40, 41]) {
  setup.push(chain(`/p${n}`, n, '/end/f'));
  setup.push(chain(`/d${n}`, n - 1, '/end/sub'), `ln -s /d${n}/l0/../f /d${n}/q`);
  rows.push([`/p${n}/l0`, n], [`/d${n}/q`, n]);
}

for (const users of ['enforce', 'off']) {
  test(`40 symlinks in one lookup resolve and 41 are ELOOP, in the WASI, JS and kernel walks (users: ${users})`, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils', 'wasi-ripgrep']) {
      await installDir(
        kernel,
        fileURLToPath(new URL(`${name}/`, modules)),
        `/node_modules/@ai-ecoverse/${name}`
      );
    }
    await installDir(kernel, fixture('readtest'), '/node_modules/readtest');
    const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
    const made = await bash(setup.join(' && '));
    assert.equal(made.status, 0, made.stderr);
    for (const [path, n] of rows) {
      const ok = n <= 40;
      const rg = await bash(`rg -c E ${path}`);
      assert.deepEqual([path, rg.status, rg.stdout], [path, ok ? 0 : 2, ok ? '1\n' : '']);
      const js = await kernel.run(['readtest', path], { cwd: '/' });
      assert.deepEqual([path, js.stdout], [path, ok ? 'E E\n' : 'ELOOP ELOOP\n']);
      const api = await kernel.readFile(path).then(
        (b) => new TextDecoder().decode(b),
        (e) => e.code
      );
      assert.deepEqual([path, api], [path, ok ? 'E' : 'ELOOP']);
      if (n === 40) continue;
      const cat = await bash(`cat ${path}`);
      assert.deepEqual([path, cat.status, cat.stdout], [path, ok ? 0 : 1, ok ? 'E' : '']);
    }
  });
}
