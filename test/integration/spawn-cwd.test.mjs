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

const SPAWNER = `const code = (w) => (typeof w === 'object' ? w.status : w);
export default async function main(ctx) {
  const cwd = ctx.argv[1];
  try {
    const child = await ctx.spawn({ argv: ['pwd'], cwd, stdout: 'null' });
    await ctx.write(1, 'spawn ' + code(await child.wait()) + '\\n');
  } catch (err) {
    await ctx.write(1, 'spawn ' + (err.code ?? err.message) + '\\n');
  }
  const run = ctx.sync.run({ argv: ['pwd'], cwd });
  await ctx.write(1, 'run ' + (run.error?.code ?? run.status) + '\\n');
  const here = await ctx.spawn({ argv: ['true'], stdout: 'null' });
  await ctx.write(1, 'inherited ' + code(await here.wait()) + '\\n');
}
`;

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
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
  await kernel.users.add({ name: 'ann' });
  await kernel.users.add({ name: 'bob' });
  await kernel.run(['bash', '-c', 'mkdir -p /home/ann/p && echo kept > /home/ann/p/f'], {
    cwd: '/home',
    user: 'ann',
  });
  return kernel;
}

test('under enforce, kernel.run in a cwd the user cannot search fails with EACCES and starts nothing (#760)', async (t) => {
  const kernel = await booted(t);
  await assert.rejects(
    kernel.run(['bash', '-c', 'pwd; echo ran > /tmp/ran'], { cwd: '/home/ann/p', user: 'bob' }),
    { code: 'EACCES', message: 'cannot change to /home/ann/p: Permission denied' }
  );
  await assert.rejects(
    kernel.openTerminal(['bash'], { cwd: '/home/ann/p', user: 'bob', onData() {} }),
    {
      code: 'EACCES',
    }
  );
  assert.deepEqual(await kernel.run(['bash', '-c', 'ls /tmp; cat /home/ann/p/f'], { cwd: '/' }), {
    status: 0,
    stdout: 'kept\n',
    stderr: '',
  });
  assert.deepEqual(await kernel.run(['pwd'], { cwd: '/home/ann/p', user: 'ann' }), {
    status: 0,
    stdout: '/home/ann/p\n',
    stderr: '',
  });
  assert.deepEqual(await kernel.run(['pwd'], { cwd: '/home/ann/p' }), {
    status: 0,
    stdout: '/home/ann/p\n',
    stderr: '',
  });
});

test('under enforce, a process spawning a child into a cwd its user cannot search gets EACCES (#760)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['spawner', '/home/ann/p'], { cwd: '/tmp', user: 'bob' }), {
    status: 0,
    stdout: 'spawn EACCES\nrun EACCES\ninherited 0\n',
    stderr: '',
  });
  assert.deepEqual(await kernel.run(['spawner', '/home/ann/p'], { cwd: '/tmp', user: 'ann' }), {
    status: 0,
    stdout: 'spawn 0\nrun 0\ninherited 0\n',
    stderr: '',
  });
  const kept = 'mkdir /tmp/x && cd /tmp/x && chmod 0 /tmp/x && env true; echo $?';
  assert.deepEqual(await kernel.run(['bash', '-c', kept], { cwd: '/tmp', user: 'bob' }), {
    status: 0,
    stdout: '0\n',
    stderr: '',
  });
});
