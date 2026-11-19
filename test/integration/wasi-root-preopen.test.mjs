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

const WASI = 'wasi_snapshot_preview1';

const PROBE = `(module
  (import "${WASI}" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "${WASI}" "fd_prestat_get" (func $prestat_get (param i32 i32) (result i32)))
  (import "${WASI}" "fd_prestat_dir_name" (func $prestat_dir_name (param i32 i32 i32) (result i32)))
  (import "${WASI}" "path_filestat_get" (func $path_filestat_get (param i32 i32 i32 i32 i32) (result i32)))
  (import "${WASI}" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "${WASI}" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "${WASI}" "environ_sizes_get" (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "${WASI}" "environ_get" (func $environ_get (param i32 i32) (result i32)))
  (memory (export "memory") 2)
  (data (i32.const 48) " \\n/.PWD=root ")
  (global $count (mut i32) (i32.const 0))
  (global $pool (mut i32) (i32.const 1024))
  (global $cwd (mut i32) (i32.const 50))
  (global $cwdlen (mut i32) (i32.const 1))
  (func $strlen (param $p i32) (result i32) (local $n i32)
    (block $done (loop $next
      (br_if $done (i32.eqz (i32.load8_u (i32.add (local.get $p) (local.get $n)))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $next)))
    (local.get $n))
  (func $copy (param $to i32) (param $from i32) (param $n i32) (local $i i32)
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (i32.store8 (i32.add (local.get $to) (local.get $i)) (i32.load8_u (i32.add (local.get $from) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next))))
  (func $prefix (param $s i32) (param $sn i32) (param $p i32) (param $pn i32) (result i32) (local $i i32)
    (if (i32.gt_u (local.get $pn) (local.get $sn)) (then (return (i32.const 0))))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $pn)))
      (if (i32.ne (i32.load8_u (i32.add (local.get $s) (local.get $i))) (i32.load8_u (i32.add (local.get $p) (local.get $i))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (i32.const 1))
  (func $out (param $p i32) (param $n i32)
    (i32.store (i32.const 0) (local.get $p))
    (i32.store (i32.const 4) (local.get $n))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8))))
  (func $num (param $v i32) (local $p i32)
    (local.set $p (i32.const 40000))
    (loop $digit
      (local.set $p (i32.sub (local.get $p) (i32.const 1)))
      (i32.store8 (local.get $p) (i32.add (i32.const 48) (i32.rem_u (local.get $v) (i32.const 10))))
      (local.set $v (i32.div_u (local.get $v) (i32.const 10)))
      (br_if $digit (local.get $v)))
    (call $out (local.get $p) (i32.sub (i32.const 40000) (local.get $p))))
  (func $preopens (local $fd i32) (local $err i32) (local $len i32) (local $e i32)
    (local.set $fd (i32.const 3))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $fd) (i32.const 1024)))
      (local.set $err (call $prestat_get (local.get $fd) (i32.const 128)))
      (br_if $done (i32.eq (local.get $err) (i32.const 8)))
      (if (i32.and (i32.eqz (local.get $err)) (i32.eqz (i32.load8_u (i32.const 128))))
        (then
          (local.set $len (i32.load (i32.const 132)))
          (drop (call $prestat_dir_name (local.get $fd) (global.get $pool) (local.get $len)))
          (local.set $e (i32.add (i32.const 256) (i32.mul (global.get $count) (i32.const 12))))
          (i32.store (local.get $e) (local.get $fd))
          (i32.store offset=4 (local.get $e) (global.get $pool))
          (i32.store offset=8 (local.get $e) (local.get $len))
          (global.set $pool (i32.add (global.get $pool) (local.get $len)))
          (global.set $count (i32.add (global.get $count) (i32.const 1)))))
      (local.set $fd (i32.add (local.get $fd) (i32.const 1)))
      (br $next))))
  (func $pwd (local $n i32) (local $i i32) (local $p i32) (local $len i32)
    (drop (call $environ_sizes_get (i32.const 16) (i32.const 20)))
    (drop (call $environ_get (i32.const 16384) (i32.const 20480)))
    (local.set $n (i32.load (i32.const 16)))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $p (i32.load (i32.add (i32.const 16384) (i32.mul (local.get $i) (i32.const 4)))))
      (local.set $len (call $strlen (local.get $p)))
      (if (call $prefix (local.get $p) (local.get $len) (i32.const 52) (i32.const 4))
        (then
          (global.set $cwd (i32.add (local.get $p) (i32.const 4)))
          (global.set $cwdlen (i32.sub (local.get $len) (i32.const 4)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next))))
  (func $probe (param $a i32) (param $an i32)
    (local $len i32) (local $i i32) (local $e i32) (local $best i32) (local $bestlen i32) (local $rest i32) (local $restlen i32)
    (if (i32.and (i32.gt_u (local.get $an) (i32.const 0)) (i32.eq (i32.load8_u (local.get $a)) (i32.const 47)))
      (then
        (call $copy (i32.const 32768) (local.get $a) (local.get $an))
        (local.set $len (local.get $an)))
      (else
        (call $copy (i32.const 32768) (global.get $cwd) (global.get $cwdlen))
        (local.set $len (global.get $cwdlen))
        (if (i32.eqz (i32.and (i32.eq (local.get $an) (i32.const 1)) (i32.eq (i32.load8_u (local.get $a)) (i32.const 46))))
          (then
            (if (i32.ne (i32.load8_u (i32.add (i32.const 32767) (local.get $len))) (i32.const 47))
              (then
                (i32.store8 (i32.add (i32.const 32768) (local.get $len)) (i32.const 47))
                (local.set $len (i32.add (local.get $len) (i32.const 1)))))
            (call $copy (i32.add (i32.const 32768) (local.get $len)) (local.get $a) (local.get $an))
            (local.set $len (i32.add (local.get $len) (local.get $an)))))))
    (local.set $best (i32.const -1))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (global.get $count)))
      (local.set $e (i32.add (i32.const 256) (i32.mul (local.get $i) (i32.const 12))))
      (if (i32.and
            (i32.gt_u (i32.load offset=8 (local.get $e)) (local.get $bestlen))
            (call $prefix (i32.const 32768) (local.get $len) (i32.load offset=4 (local.get $e)) (i32.load offset=8 (local.get $e))))
        (then
          (local.set $best (i32.load (local.get $e)))
          (local.set $bestlen (i32.load offset=8 (local.get $e)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.set $rest (i32.add (i32.const 32768) (local.get $bestlen)))
    (local.set $restlen (i32.sub (local.get $len) (local.get $bestlen)))
    (block $done (loop $next
      (br_if $done (i32.eqz (local.get $restlen)))
      (br_if $done (i32.ne (i32.load8_u (local.get $rest)) (i32.const 47)))
      (local.set $rest (i32.add (local.get $rest) (i32.const 1)))
      (local.set $restlen (i32.sub (local.get $restlen) (i32.const 1)))
      (br $next)))
    (if (i32.eqz (local.get $restlen))
      (then (local.set $rest (i32.const 51)) (local.set $restlen (i32.const 1))))
    (call $out (local.get $a) (local.get $an))
    (call $out (i32.const 48) (i32.const 1))
    (call $num (call $path_filestat_get (local.get $best) (i32.const 1) (local.get $rest) (local.get $restlen) (i32.const 64)))
    (call $out (i32.const 49) (i32.const 1)))
  (func (export "_start") (local $argc i32) (local $i i32) (local $a i32) (local $root i32) (local $e i32)
    (call $preopens)
    (call $pwd)
    (drop (call $args_sizes_get (i32.const 16) (i32.const 20)))
    (drop (call $args_get (i32.const 8192) (i32.const 9216)))
    (local.set $argc (i32.load (i32.const 16)))
    (local.set $i (i32.const 1))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $argc)))
      (local.set $a (i32.load (i32.add (i32.const 8192) (i32.mul (local.get $i) (i32.const 4)))))
      (call $probe (local.get $a) (call $strlen (local.get $a)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (global.get $count)))
      (local.set $e (i32.add (i32.const 256) (i32.mul (local.get $i) (i32.const 12))))
      (if (i32.and
            (i32.eq (i32.load offset=8 (local.get $e)) (i32.const 1))
            (i32.eq (i32.load8_u (i32.load offset=4 (local.get $e))) (i32.const 47)))
        (then (local.set $root (i32.load (local.get $e)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (call $out (i32.const 56) (i32.const 5))
    (call $num (i32.ne (local.get $root) (i32.const 0)))
    (call $out (i32.const 49) (i32.const 1))))`;

async function probeWasm() {
  const wabt = await wabtInit();
  const mod = wabt.parseWat('probe.wat', PROBE);
  const bytes = new Uint8Array(mod.toBinary({}).buffer);
  mod.destroy();
  return bytes;
}

const PATHS = ['/', '/nonexistent', '/tmp/nonexistent', 'nope', '.'];
const ROOTED = '/ 0\n/nonexistent 44\n/tmp/nonexistent 44\nnope 44\n. 0\nroot 1\n';
const UNROOTED = '/ 8\n/nonexistent 8\n/tmp/nonexistent 44\nnope 8\n. 8\nroot 0\n';

async function kernelWithProbe(t) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const wasm = await probeWasm();
  await kernel.writeFile(
    '/node_modules/goprobe/package.json',
    JSON.stringify({
      name: 'goprobe',
      slicc: {
        abi: 'wasi',
        commands: {
          plain: { wasm: 'bin/plain.wasm' },
          rooted: { wasm: 'bin/rooted.wasm', preopenRoot: true },
        },
      },
    })
  );
  await kernel.writeFile('/node_modules/goprobe/bin/plain.wasm', wasm);
  await kernel.writeFile('/node_modules/goprobe/bin/rooted.wasm', wasm);
  await kernel.writeFile('/work/probe.wasm', wasm);
  await kernel.run(['bash', '-c', 'mkdir -p /tmp && chmod +x /work/probe.wasm'], { cwd: '/' });
  const run = async (argv, cwd = '/') => {
    const r = await kernel.run(argv, { cwd, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(r.stderr, '', argv.join(' '));
    assert.equal(r.status, 0, argv.join(' '));
    return r.stdout;
  };
  return { run };
}

test('a .wasm run by path that no package owns gets the root preopen, so a Go-style lookup of /, a missing top-level path and getwd from / work (#1868)', async (t) => {
  const { run } = await kernelWithProbe(t);
  assert.equal(await run(['/work/probe.wasm', ...PATHS]), ROOTED);
  assert.equal(await run(['./work/probe.wasm', ...PATHS]), ROOTED);
  assert.equal(await run(['bash', '-c', `/work/probe.wasm ${PATHS.join(' ')}`]), ROOTED);
  assert.equal(
    await run(['bash', '-c', `cd /work && exec ./probe.wasm ${PATHS.join(' ')}`]),
    ROOTED
  );
  assert.equal(
    await run([
      'bash',
      '-c',
      `ln -s /work/probe.wasm /tmp/linked && /tmp/linked ${PATHS.join(' ')}`,
    ]),
    ROOTED
  );
});

test('a package command keeps its manifest layout: without preopenRoot nothing is named /, with it the same root layout as by path (#1868, #179)', async (t) => {
  const { run } = await kernelWithProbe(t);
  assert.equal(await run(['plain', ...PATHS]), UNROOTED);
  assert.equal(await run(['/node_modules/goprobe/bin/plain.wasm', ...PATHS]), UNROOTED);
  assert.equal(await run(['bash', '-c', `plain ${PATHS.join(' ')}`]), UNROOTED);
  assert.equal(await run(['rooted', ...PATHS]), ROOTED);
  assert.equal(await run(['/node_modules/goprobe/bin/rooted.wasm', ...PATHS]), ROOTED);
  assert.equal(await run(['/work/probe.wasm', ...PATHS]), await run(['rooted', ...PATHS]));
});
