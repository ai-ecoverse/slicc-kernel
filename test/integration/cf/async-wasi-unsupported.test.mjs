import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../../dist/node.js';
import { installFixture, installPackage, skip } from './async-wasi-harness.mjs';

const fixtures = new URL('../fixtures/', import.meta.url);

async function asyncKernel(t) {
  const kernel = await createNodeKernel({ blocking: 'async' });
  t.after(() => kernel.terminate());
  return kernel;
}

const soon = (work, ms = 20000) =>
  Promise.race([work, new Promise((resolve) => setTimeout(() => resolve('timed out'), ms))]);

test('a thread cannot start on the async host: pthread_create fails at once, nothing hangs', {
  skip,
}, async (t) => {
  const kernel = await asyncKernel(t);
  await installPackage(kernel, 'wasix-python');
  await installFixture(kernel, 'epolltest');
  const r = await soon(
    kernel.run(
      [
        'python',
        '-c',
        'import threading\ntry:\n  threading.Thread(target=print).start()\nexcept RuntimeError as e:\n  print("refused:", e)',
      ],
      { cwd: '/' }
    )
  );
  assert.deepEqual(r, { status: 0, stdout: "refused: can't start new thread\n", stderr: '' });
  assert.deepEqual(await soon(kernel.run(['epolltest', 'cross-thread'], { cwd: '/' })), {
    status: 0,
    stdout: 'woken by thread: 0\n',
    stderr: '',
  });
});

test('dlopen of a side module is refused with a message: wasm is never compiled at run time', {
  skip,
}, async (t) => {
  const kernel = await asyncKernel(t);
  await installFixture(kernel, 'forktls');
  await kernel.writeFile(
    '/usr/lib/libtlsside.so',
    await readFile(new URL('forktls/lib/libtlsside.so', fixtures))
  );
  assert.deepEqual(
    await soon(kernel.run(['forktls-pie', '/usr/lib/libtlsside.so'], { cwd: '/' })),
    {
      status: 1,
      stdout:
        'dlopen: /usr/lib/libtlsside.so: not a wasm module (compiling wasm at run time is not supported by the async process host)\n',
      stderr: '',
    }
  );
});

test('a JS program is refused with 126 and a message on the async host', { skip }, async (t) => {
  const kernel = await asyncKernel(t);
  await installFixture(kernel, 'jstest');
  assert.deepEqual(await soon(kernel.run(['jstest'], { cwd: '/' })), {
    status: 126,
    stdout: '',
    stderr: 'the async process host runs no JS programs\n',
  });
});
