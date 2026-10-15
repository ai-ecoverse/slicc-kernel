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

const JS = `export default async function main(ctx) {
  const out = [];
  for (const path of ctx.argv.slice(1)) {
    for (const [how, run] of [
      ['sync', () => ctx.sync.fs.mkdir(path, { recursive: false })],
      ['async', () => ctx.fs.mkdir(path, { recursive: false })],
    ]) {
      try {
        await run();
        out.push(path + ' ' + how + ' ok');
      } catch (err) {
        out.push(path + ' ' + how + ' ' + err.code);
      }
    }
  }
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

for (const users of ['off', 'enforce']) {
  test(`an exclusive mkdir of the root or a mount point is EEXIST (#659, users: ${users})`, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
    await kernel.writeFile(
      '/node_modules/mk/package.json',
      JSON.stringify({ name: 'mk', slicc: { commands: { mk: { abi: 'js', module: 'main.mjs' } } } })
    );
    await kernel.writeFile('/node_modules/mk/main.mjs', JS);
    await kernel.run(['mkdir', '-p', '/mnt/t'], { cwd: '/' });
    await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
    const js = await kernel.run(['mk', '/', '/mnt/t', '/tmp'], { cwd: '/' });
    const want = ['/', '/mnt/t', '/tmp'].flatMap((p) => [`${p} sync EEXIST`, `${p} async EEXIST`]);
    assert.deepEqual(js.stdout.trim().split('\n'), want);
    const sh = await kernel.run(['bash', '-c', 'mkdir /; echo rc=$?; mkdir /mnt/t; echo rc=$?'], {
      cwd: '/',
    });
    assert.equal(sh.stdout, 'rc=1\nrc=1\n');
    assert.match(sh.stderr, /cannot create directory ‘\/’: File exists/);
    assert.match(sh.stderr, /cannot create directory ‘\/mnt\/t’: File exists/);
  });
}
