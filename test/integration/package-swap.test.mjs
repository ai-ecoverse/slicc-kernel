import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';
import * as testing from '../../dist/testing.js';
import { PAIR_FILES, PAIR_ROOT } from './pair-package.mjs';

const ASIDE = `${PAIR_ROOT}_old`;
const STAGE = `${PAIR_ROOT}_tmp`;
const WASM = `${PAIR_ROOT}/bin/pairtest.wasm`;
const LOCK = `slicc-kernel-replacing:v1:slicc-kernel:${PAIR_ROOT}`;
const BASH = new URL('../../node_modules/@ai-ecoverse/wasm-bash/', import.meta.url);

const SWAPPER = `export default async function main(ctx) {
  const [, dir, aside, stage, between] = ctx.argv;
  await ctx.fs.rename(dir, aside);
  await ctx.umask();
  if (between) {
    const started = Date.now();
    let status;
    try {
      const child = await ctx.spawn({ argv: [between], stdout: 'null', stderr: 'null' });
      const done = await child.wait();
      status = done?.status ?? done;
    } catch (err) {
      status = err.code ?? err.message;
    }
    await ctx.write(1, 'child ' + status + ' after ' + (Date.now() - started) + '\\n');
  }
  await ctx.fs.rename(stage, dir);
  await ctx.fs.rm(aside, { recursive: true });
}
`;

async function swapKernel(t) {
  const kernel = await createNodeKernel({ root: memoryRoot() });
  t.after(() => kernel.terminate());
  t.after(() => testing.setTestSyscallHook(undefined));
  for (const [file, data] of PAIR_FILES(1)) await kernel.writeFile(`${PAIR_ROOT}/${file}`, data);
  for (const [file, data] of PAIR_FILES(2)) await kernel.writeFile(`${STAGE}/${file}`, data);
  await kernel.writeFile(
    '/node_modules/swapper/package.json',
    JSON.stringify({
      name: 'swapper',
      slicc: { commands: { swapper: { abi: 'js', module: 'swap.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/swapper/swap.mjs', SWAPPER);
  for (const file of ['package.json', 'bin/bash', 'bin/bash.wasm']) {
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/wasm-bash/${file}`,
      await readFile(new URL(file, BASH))
    );
  }
  return kernel;
}

function pauseBetweenRenames() {
  const gate = Promise.withResolvers();
  const paused = Promise.withResolvers();
  let seen = 0;
  testing.setTestSyscallHook(async ({ op }) => {
    if (op !== 'proc-umask' || ++seen !== 1) return;
    paused.resolve();
    await gate.promise;
  });
  return { paused: paused.promise, release: () => gate.resolve() };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function locksOn(name) {
  const { held = [], pending = [] } = await navigator.locks.query();
  const on = (list) =>
    list
      .filter((lock) => lock.name === name)
      .map((lock) => lock.mode)
      .sort();
  return { held: on(held), pending: on(pending) };
}

const swaps = async (kernel) =>
  (
    await kernel.run(['bash', '-c', 'echo $(< /proc/sys/kernel/slicc_package_swaps)'], {
      cwd: '/',
    })
  ).stdout
    .trim()
    .split(' ')
    .map(Number);

test('an exec by path or by name between the two renames of an in-kernel package swap waits for the rename in and runs the new pair, never ENOENT or the aside copy (#1705)', async (t) => {
  const kernel = await swapKernel(t);
  assert.equal((await kernel.run(['pairtest'], { cwd: '/' })).status, 1);
  const { paused, release } = pauseBetweenRenames();
  const swap = kernel.run(['swapper', PAIR_ROOT, ASIDE, STAGE], { cwd: '/' });
  await paused;
  const during = await locksOn(LOCK);
  const done = {};
  const byPath = kernel.run([WASM], { cwd: '/' }).then((r) => (done.byPath = r));
  const byName = kernel.run(['pairtest'], { cwd: '/' }).then((r) => (done.byName = r));
  await settle(300);
  const early = Object.keys(done);
  release();
  assert.deepEqual(await byPath, { status: 2, stdout: '', stderr: '' });
  assert.deepEqual(await byName, { status: 2, stdout: '', stderr: '' });
  assert.deepEqual(early, []);
  assert.deepEqual(during, { held: ['exclusive'], pending: [] });
  assert.deepEqual(await swap, { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(await locksOn(LOCK), { held: [], pending: [] });
  const [count, longest, waits] = await swaps(kernel);
  assert.equal(count, 1);
  assert.ok(longest >= 250 && longest < 2000, String(longest));
  assert.ok(waits >= 2, String(waits));
});

test("a running shell's child that execs under a package mid-swap waits for the rename in and gets the new pair, as a pnpm lifecycle script would (#1705)", async (t) => {
  const kernel = await swapKernel(t);
  const shell = kernel.run(
    [
      'bash',
      '-c',
      ': > /tmp/ready; until [ -e /tmp/go ]; do :; done; pairtest; echo "pairtest $?"',
    ],
    { cwd: '/' }
  );
  for (let i = 0; i < 500; i++) {
    if (
      await kernel.readFile('/tmp/ready').then(
        () => true,
        () => false
      )
    )
      break;
    await settle(10);
  }
  const { paused, release } = pauseBetweenRenames();
  const swap = kernel.run(['swapper', PAIR_ROOT, ASIDE, STAGE], { cwd: '/' });
  await paused;
  const done = {};
  void shell.then(() => (done.shell = true));
  await kernel.writeFile('/tmp/go', '');
  await settle(300);
  const early = Object.keys(done);
  release();
  assert.deepEqual(await shell, { status: 0, stdout: 'pairtest 2\n', stderr: '' });
  assert.deepEqual(early, []);
  assert.equal((await swap).status, 0);
});

test('a swapper that execs under the package between its own two renames does not wait for ever: its child gives up after the 2 s bound, the swap completes and the next exec runs the new pair (#1705)', {
  timeout: 60_000,
}, async (t) => {
  const kernel = await swapKernel(t);
  const started = Date.now();
  const swap = await kernel.run(['swapper', PAIR_ROOT, ASIDE, STAGE, WASM], { cwd: '/' });
  const took = Date.now() - started;
  assert.equal(swap.status, 0, swap.stderr);
  const [, status, , after] = swap.stdout.trim().split(' ');
  assert.equal(status, 'ENOENT');
  assert.ok(Number(after) >= 1900, swap.stdout);
  assert.ok(took < 10_000, String(took));
  assert.deepEqual(await kernel.run(['pairtest'], { cwd: '/' }), {
    status: 2,
    stdout: '',
    stderr: '',
  });
  assert.deepEqual(await locksOn(LOCK), { held: [], pending: [] });
});
