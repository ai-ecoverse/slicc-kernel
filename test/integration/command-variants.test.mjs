import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
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

const say = (text) => `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 32) "${text}\\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 32))
    (i32.store (i32.const 4) (i32.const ${text.length + 1}))
    (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))`;

async function wasmOf(wabt, text) {
  const mod = wabt.parseWat(`${text}.wat`, say(text));
  const bytes = new Uint8Array(mod.toBinary({}).buffer);
  mod.destroy();
  return bytes;
}

async function kernelWith(t, variants) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const wabt = await wabtInit();
  await kernel.writeFile(
    '/node_modules/pick/package.json',
    JSON.stringify({
      name: 'pick',
      slicc: { abi: 'wasi', commands: { pick: { wasm: 'bin/plain.wasm', variants } } },
    })
  );
  await kernel.writeFile('/node_modules/pick/bin/plain.wasm', await wasmOf(wabt, 'plain'));
  await kernel.writeFile('/node_modules/pick/bin/fork.wasm', await wasmOf(wabt, 'fork'));
  await kernel.writeFile('/node_modules/pick/bin/both.wasm', await wasmOf(wabt, 'both'));
  const run = async (argv, env = {}) => {
    const r = await kernel.run(argv, { cwd: '/', env: { PATH: '/usr/bin:/bin', ...env } });
    assert.equal(r.stderr, '');
    return r.stdout;
  };
  return { kernel, run };
}

const VARIANTS = [
  { env: { PYTHON_FORK: 'true', SECOND: 'yes' }, wasm: 'bin/both.wasm' },
  { env: { PYTHON_FORK: 'true' }, wasm: 'bin/fork.wasm' },
];

test("a command's variant is chosen by the new process's environment, first match first, else its wasm", async (t) => {
  const { run } = await kernelWith(t, VARIANTS);
  assert.equal(await run(['pick']), 'plain\n');
  assert.equal(await run(['pick'], { PYTHON_FORK: 'true' }), 'fork\n');
  assert.equal(await run(['pick'], { PYTHON_FORK: 'true', SECOND: 'yes' }), 'both\n');
  assert.equal(await run(['pick'], { PYTHON_FORK: 'TRUE' }), 'plain\n');
  assert.equal(await run(['pick'], { PYTHON_FORK: '1' }), 'plain\n');
});

test('bash picks the variant for `VAR=value cmd` and exec, and a child inherits the choice through its env', async (t) => {
  const { run } = await kernelWith(t, VARIANTS);
  assert.equal(
    await run(['bash', '-c', 'pick; PYTHON_FORK=true pick; pick']),
    'plain\nfork\nplain\n'
  );
  assert.equal(await run(['bash', '-c', 'PYTHON_FORK=true exec pick']), 'fork\n');
  assert.equal(
    await run(['bash', '-c', 'pick; bash -c pick'], { PYTHON_FORK: 'true' }),
    'fork\nfork\n'
  );
  assert.equal(
    await run(['bash', '-c', 'unset PYTHON_FORK; pick'], { PYTHON_FORK: 'true' }),
    'plain\n'
  );
  assert.equal(
    await run(['bash', '-c', 'cat /usr/bin/pick | wc -c']),
    `${await run(['bash', '-c', 'cat /node_modules/pick/bin/plain.wasm | wc -c'])}`
  );
});

test('a malformed variants block is ignored with one warning, and the command runs its wasm', async (t) => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  t.after(() => {
    console.warn = warn;
  });
  for (const variants of [
    { env: { PYTHON_FORK: 'true' }, wasm: 'bin/fork.wasm' },
    [{ env: { PYTHON_FORK: true }, wasm: 'bin/fork.wasm' }],
  ]) {
    warned.length = 0;
    const { run } = await kernelWith(t, variants);
    assert.equal(await run(['pick'], { PYTHON_FORK: 'true' }), 'plain\n');
    assert.equal(await run(['pick'], { PYTHON_FORK: 'true' }), 'plain\n');
    assert.equal(
      warned.filter((w) => w.includes('malformed "variants"')).length,
      1,
      warned.join('\n')
    );
  }
});
