import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const FILES = ['package.json', 'bin/main.mjs', 'bin/jswasi.wasm', 'bin/jswasi-shared.wasm'];
const fixture = new URL('fixtures/jswasi/', import.meta.url);

async function booted(t, options = {}, users = []) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  for (const name of users) await kernel.users.add({ name });
  for (const file of FILES) {
    await kernel.writeFile(`/node_modules/jswasi/${file}`, await readFile(new URL(file, fixture)));
  }
  return async (name, opts = {}) => {
    const r = await kernel.run(['jswasi', name], { cwd: '/', ...opts });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
}

test('ctx.sync.wasi.create: a preview1 program reads and writes files under a preopen, lists it, names it, and prints to the given stdout, on its own non-shared memory (#1111)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('io'), {
    stdout: 'hello from the host\nentries 4\npreopen 3 /sandbox\n',
    out: 21,
  });
});

test('ctx.sync.wasi.create: args and env are exactly the given ones, start returns the proc_exit code, with returnOnExit false it throws JsWasiExit with that code, and bad stdio, preopens, memory or a missing _start are refused without leaving a descriptor (#1111)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('start'), {
    code: 4,
    thrown: { name: 'JsWasiExit', code: 4 },
    refused: [
      { name: 'JsCallError', code: 'EINVAL' },
      { name: 'JsCallError', code: 'EINVAL' },
      null,
    ],
    badStdio: { name: 'JsCallError', code: 'EBADF' },
    badPreopens: [
      { name: 'JsCallError', code: 'EINVAL' },
      { name: 'JsCallError', code: 'EINVAL' },
    ],
    fds: 4,
    stdout: 'prog one\nA=b\nclock ok\nclock ok\n',
  });
});

test('ctx.sync.wasi.create: a path that leaves the preopen by .. or is absolute is refused with ENOTCAPABLE, as Node does, and .. inside it is fine (#1111)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('escape'), {
    stdout: 'dotdot 76 absolute 76 inner dotdot 0 file as dir 54 stdin as dir 54\n',
  });
});

test('ctx.sync.wasi.create: guest fd numbers that collide with the program own open fds never reach them, renumber stays among guest fds, and close leaves only the program fds (#1111)', async (t) => {
  const run = await booted(t);
  const r = await run('collide');
  assert.deepEqual(r.before, [3, 4, 5, 6]);
  assert.equal(r.stdout, 'guest fd 4\nrenumber 8 8 0\nstray fd 5 8\n');
  assert.deepEqual(r.kept, ['own 0\n', 'own 1\n', 'own 2\n', 'own 3\n']);
  assert.equal(r.guest, 'guest bytes\nafter renumber\n');
  assert.equal(r.guest2, '');
  assert.equal(r.open, r.closed + 4);
});

test('ctx.sync.wasi.create in ctx.thread: threads share the WebAssembly.Memory and the preopens, and a thread that ends with guest fds open leaves none behind in /dev/fd (#1111, #1094)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('threads'), {
    codes: [0, 0],
    before: 3,
    after: 3,
    files: ['t-1.txt', 't-2.txt'],
    shared: true,
  });
});

test('ctx.sync.wasi.create in ctx.thread: a thread that ends by sync.exit, or is terminated, while its guest holds fds leaves none behind either (#1111)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('terminate'), {
    before: 3,
    exitCode: 6,
    afterExit: 3,
    holding: 3 + 3 + 1 + 3,
    code: 1,
    after: 3,
  });
});

test('ctx.sync.wasi.create: poll_oneoff sees guest fds, a guest fd with no entry is EBADF in its event, and the subscriptions come back unchanged (#1111)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('poll'), { stdout: 'poll 0 got 2 11:8 10:0 fds kept 0,42\n' });
});

test('ctx.sync.wasi.create: the guest has the program permissions and no more, so a preopen the user may not write gives EACCES (#1111)', async (t) => {
  const run = await booted(t, { users: 'enforce' }, ['cone']);
  assert.deepEqual(await run('readonly', { user: 'cone', env: { RO_DIR: '/etc' } }), {
    stdout: 'mkdir 2\n',
  });
});

test('ctx.sync.wasi.create in the page: the same preview1 program reads, writes, lists and renumbers under a preopen (#1111)', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page, run } = await bootedPage(chrome, t);
  await page.evaluate(async (files) => {
    for (const name of files) {
      const bytes = await (await fetch(`/fixtures/jswasi/${name}`)).arrayBuffer();
      await window.opfs.write(`node_modules/jswasi/${name}`, bytes);
    }
  }, FILES);
  for (const [name, want] of [
    ['io', { stdout: 'hello from the host\nentries 4\npreopen 3 /sandbox\n', out: 21 }],
    ['escape', { stdout: 'dotdot 76 absolute 76 inner dotdot 0 file as dir 54 stdin as dir 54\n' }],
  ]) {
    const r = await run(['jswasi', name], { cwd: '/' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), want);
  }
});
