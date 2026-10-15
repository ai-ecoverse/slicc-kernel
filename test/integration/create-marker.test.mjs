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

const MAKE = `(module
  (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 16) "w")
  (data (i32.const 32) "made by wasi")
  (func (export "_start")
    (local $r i32)
    (local.set $r (call $open (i32.const 3) (i32.const 0) (i32.const 16) (i32.const 1) (i32.const 1) (i64.const 0x1fffffff) (i64.const 0x1fffffff) (i32.const 0) (i32.const 64)))
    (if (local.get $r) (then (call $exit (local.get $r))))
    (i32.store (i32.const 72) (i32.const 32))
    (i32.store (i32.const 76) (i32.const 12))
    (local.set $r (call $write (i32.load (i32.const 64)) (i32.const 72) (i32.const 1) (i32.const 80)))
    (call $exit (i32.or (local.get $r) (call $close (i32.load (i32.const 64)))))))`;

test('a WASI program writes a file it creates without write permission for itself, and the next open is checked (users: enforce)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const wabt = await wabtInit();
  const mod = wabt.parseWat('make.wat', MAKE);
  await kernel.writeFile(
    '/node_modules/make/package.json',
    JSON.stringify({ slicc: { abi: 'wasi', commands: { make: { wasm: 'make.wasm' } } } })
  );
  await kernel.writeFile('/node_modules/make/make.wasm', new Uint8Array(mod.toBinary({}).buffer));
  mod.destroy();
  await kernel.users.add({ name: 'cone' });
  await kernel.run(['bash', '-c', 'mkdir -p /work && chown cone:cone /work']);
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/work', user: 'cone' });
  assert.deepEqual(await bash('( umask 777; make ); echo rc=$?; stat -c %a w'), {
    status: 0,
    stdout: 'rc=0\n0\n',
    stderr: '',
  });
  assert.deepEqual(await bash('make; echo rc=$?'), { status: 0, stdout: 'rc=2\n', stderr: '' });
  assert.deepEqual(await kernel.run(['cat', '/work/w']), {
    status: 0,
    stdout: 'made by wasi',
    stderr: '',
  });
});
