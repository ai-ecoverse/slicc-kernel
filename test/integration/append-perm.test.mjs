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

test("a user without write permission gets EACCES appending to root's 0644 file, in bash, WASI and JS, and the file is unchanged (#1525 review)", {
  timeout: 300_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(
    '/node_modules/jsapp/package.json',
    JSON.stringify({
      name: 'jsapp',
      slicc: { commands: { jsapp: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile(
    '/node_modules/jsapp/main.mjs',
    `export default async function main(ctx) {
  try {
    await ctx.open('/tmp/ro/log', { write: true, append: true });
    await ctx.write(1, 'opened\\n');
  } catch (err) {
    await ctx.write(1, err.code + '\\n');
  }
  return 0;
}`
  );
  const root = (s) => kernel.run(['bash', '-c', s], { cwd: '/' });
  await root(
    'mkdir -p /tmp/ro && chmod 755 /tmp/ro && echo keep > /tmp/ro/log && chmod 644 /tmp/ro/log'
  );
  const py =
    "import os\ntry:\n    os.open('/tmp/ro/log', os.O_WRONLY | os.O_APPEND); print('opened')\nexcept OSError as e:\n    print(e.strerror)";
  const asCone = (argv) => kernel.run(argv, { cwd: '/', user: 'cone' });
  const bash = await asCone(['bash', '-c', 'echo bad >> /tmp/ro/log; echo "rc $?"']);
  assert.match(bash.stdout, /rc 1\n$/);
  assert.match(bash.stderr, /Permission denied/);
  assert.deepEqual(await asCone(['python3', '-c', py]), {
    status: 0,
    stdout: 'Permission denied\n',
    stderr: '',
  });
  assert.deepEqual(await asCone(['jsapp']), { status: 0, stdout: 'EACCES\n', stderr: '' });
  assert.deepEqual(await root('cat /tmp/ro/log'), { status: 0, stdout: 'keep\n', stderr: '' });
});
