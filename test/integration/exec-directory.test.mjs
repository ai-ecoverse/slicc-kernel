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

const SPAWNER = `export default async function main(ctx) {
  for (const file of ctx.argv.slice(1)) {
    try {
      const child = await ctx.spawn({ argv: [file] });
      await ctx.write(1, 'spawned ' + (await child.wait()) + '\\n');
    } catch (err) {
      await ctx.write(1, (err.code ?? err.message) + '\\n');
    }
  }
}
`;

for (const users of ['off', 'enforce']) {
  test(`running a directory fails as on Linux: EACCES, "Is a directory", 126 (users: ${users})`, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
    await kernel.writeFile(
      '/node_modules/spawner/package.json',
      JSON.stringify({
        name: 'spawner',
        slicc: { commands: { spawner: { abi: 'js', module: 'main.mjs' } } },
      })
    );
    await kernel.writeFile('/node_modules/spawner/main.mjs', SPAWNER);
    await kernel.run(['mkdir', '-p', '/tmp/dd'], { cwd: '/' });
    const sh = await kernel.run(['bash', '-c', '/tmp/dd; echo $?; /tmp/missing; echo $?'], {
      cwd: '/',
    });
    assert.equal(sh.stdout, '126\n127\n');
    assert.match(sh.stderr, /\/tmp\/dd: Is a directory/);
    assert.match(sh.stderr, /\/tmp\/missing: No such file or directory/);
    const js = await kernel.run(['spawner', '/tmp/dd', '/tmp/missing'], { cwd: '/' });
    assert.equal(js.stdout, 'EACCES\nENOENT\n');
    const direct = await kernel.run(['/tmp'], { cwd: '/' });
    assert.equal(direct.status, 126);
    assert.match(direct.stderr, /\/tmp: Is a directory/);
    assert.equal((await kernel.run(['/tmp/missing'], { cwd: '/' })).status, 127);
  });
}
