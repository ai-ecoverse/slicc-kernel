import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const PROGRAM = readFileSync(
  new URL('fixtures/jsthreads/bin/jsthreads.mjs', import.meta.url),
  'utf8'
);

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/jsthreads/package.json',
    JSON.stringify({
      name: 'jsthreads',
      slicc: { commands: { jsthreads: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/jsthreads/main.mjs', PROGRAM);
  return async (name, env) => {
    const r = await kernel.run(['jsthreads', name], { cwd: '/', ...(env ? { env } : {}) });
    assert.equal(r.status, 0, r.stderr);
    return { ...JSON.parse(r.stdout), stderr: r.stderr };
  };
}

test('ctx.thread.spawn: a thread of the same process, with messages both ways on a native port (#1094)', async (t) => {
  const run = await booted(t);
  const r = await run('messages');
  assert.deepEqual(r.main, [0, true]);
  assert.equal(r.tid, 1);
  assert.deepEqual(r.hello, { hello: 1, pid: r.pid, data: 5 });
  assert.equal(r.doubled, 42);
  assert.equal(r.ppid, true);
});

test('a SharedArrayBuffer is shared with a thread, and Atomics.wait/notify work both ways (#1094)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('sab'), { woke: true, seen: 1, got: 7, stderr: '' });
});

test('an ArrayBuffer in transfer is detached in the spawner and arrives whole (#1094)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('transfer'), { here: 0, there: 8, stderr: '' });
});

test("a thread's exit(3) and sync.exit(4) end that thread only, and the process goes on (#1094)", async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('exits'), { codes: [3, 4], alive: true, stderr: '' });
});

test('terminate() ends a thread with 1 (#1094)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('terminate'), { code: 1, stderr: '' });
});

test("the main thread's exit ends the process's threads (#1094)", async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/jsthreads/package.json',
    JSON.stringify({
      name: 'jsthreads',
      slicc: { commands: { jsthreads: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/jsthreads/main.mjs', PROGRAM);
  const r = await kernel.run(['jsthreads', 'tick'], { cwd: '/' });
  assert.equal(JSON.parse(r.stdout).started, true, r.stderr);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = new TextDecoder().decode(await kernel.readFile('/tmp/ticks'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = new TextDecoder().decode(await kernel.readFile('/tmp/ticks'));
  assert.equal(after, before, 'no tick after the process ended');
});

test('past the per-process cap (SLICC_JS_THREADS) spawn is EAGAIN, and an ended thread frees its slot (#1094)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('cap', { SLICC_JS_THREADS: '2' }), {
    third: 'EAGAIN',
    after: 3,
    stderr: '',
  });
});

test('a thread out of memory ends with NO_MEMORY (256); an uncaught error ends it with 1, and the kernel prints nothing, as Node leaves it to the Worker error event (#1094)', async (t) => {
  const run = await booted(t);
  const r = await run('oom');
  assert.deepEqual([r.oom, r.NO_MEMORY, r.throws], [256, 256, 1]);
  assert.equal(r.stderr, '');
});

test("a thread shares the process's pid and descriptor table: an fd it opens reads in the main thread (#1094)", async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('fds'), { same: true, text: 'from the thread fd', stderr: '' });
});

test('a stopped process stops its threads too, and SIGCONT resumes them (#1094)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('stop'), {
    frozen: true,
    resumed: true,
    timersFrozen: true,
    stderr: '',
  });
});

test('a WebAssembly.Module and a shared WebAssembly.Memory cross a thread port and a nested spawn, as emnapi needs (#1094)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('wasm'), { woke: true, first: 99, second: 77, inner: 5, stderr: '' });
});

test("spawn keeps the platform's MessageChannel when the program replaces the global, as a Node runtime does (#1094)", async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('stub'), { code: 3, stderr: '' });
});

test("a thread's async call that waits wakes when the kernel answers it, and a call a thread leaves in flight is cancelled when it ends (#1132 review)", async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('pipewake'), { got: 'late data', stderr: '' });
  assert.deepEqual(await run('abandon'), { code: 0, got: 'for main', stderr: '' });
});

test("a thread's signals.on/reset leave the main thread's disposition alone: signals are the main thread's (#1132 review)", async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('sigreset'), { code: 0, caught: 1, stderr: '' });
});

test('a thread can spawn a thread of its own (#1094)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('nested'), { outer: 1, inner: 2, code: 3, stderr: '' });
});

test('in Chrome: messages, a shared SAB with Atomics both ways, transfer, thread exits, terminate, the cap, OOM and the shared fd table (#1094)', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page, run } = await bootedPage(chrome, t);
  const put = (path, text) => page.evaluate((p, x) => window.opfs.write(p, x), path, text);
  await put(
    'node_modules/jsthreads/package.json',
    JSON.stringify({
      name: 'jsthreads',
      slicc: { commands: { jsthreads: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await put('node_modules/jsthreads/main.mjs', PROGRAM);
  const go = async (name, env) => {
    const r = await run(['jsthreads', name], { cwd: '/', ...(env ? { env } : {}) });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    return { ...JSON.parse(r.stdout), stderr: r.stderr };
  };
  const m = await go('messages');
  assert.deepEqual(
    [m.main, m.tid, m.hello, m.doubled],
    [[0, true], 1, { hello: 1, pid: m.pid, data: 5 }, 42]
  );
  assert.deepEqual(await go('sab'), { woke: true, seen: 1, got: 7, stderr: '' });
  assert.deepEqual(await go('transfer'), { here: 0, there: 8, stderr: '' });
  assert.deepEqual(await go('exits'), { codes: [3, 4], alive: true, stderr: '' });
  assert.deepEqual(await go('terminate'), { code: 1, stderr: '' });
  assert.deepEqual(await go('cap', { SLICC_JS_THREADS: '2' }), {
    third: 'EAGAIN',
    after: 3,
    stderr: '',
  });
  const o = await go('oom');
  assert.deepEqual([o.oom, o.throws], [256, 1]);
  assert.deepEqual(await go('fds'), { same: true, text: 'from the thread fd', stderr: '' });
  assert.deepEqual(await go('nested'), { outer: 1, inner: 2, code: 3, stderr: '' });
  assert.deepEqual(await go('stub'), { code: 3, stderr: '' });
  assert.deepEqual(await go('pipewake'), { got: 'late data', stderr: '' });
  assert.deepEqual(await go('abandon'), { code: 0, got: 'for main', stderr: '' });
  assert.deepEqual(await go('sigreset'), { code: 0, caught: 1, stderr: '' });
  assert.deepEqual(await go('wasm'), { woke: true, first: 99, second: 77, inner: 5, stderr: '' });
  assert.deepEqual(page.errors, []);
});
