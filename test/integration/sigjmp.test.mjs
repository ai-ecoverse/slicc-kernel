import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('./fixtures/sigjmptest/', import.meta.url);

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/sigjmptest.wasm']) {
    await kernel.writeFile(
      `/node_modules/sigjmptest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  const run = (mode) => kernel.run(['sigjmptest', mode], { cwd: '/tmp' });
  run.held = () =>
    kernel.readFile('/tmp/sigjmp.held').then(
      () => true,
      () => false
    );
  return run;
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

test("a WASIX handler's sa_mask holds a signal the handler sends itself until it returns (#975)", {
  timeout: 60_000,
}, async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('term'), ok('term-done usr1\n'));
});

test('a longjmp out of a WASIX signal handler lands in the program, keeps the handler mask as on Linux, and the next signal runs its handler (#1059)', {
  timeout: 120_000,
}, async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('longjmp'), ok('jumped\nusr1=1 usr2=1 alrm=0\nagain=2\n'));
  for (const how of ['sleep', 'nanosleep', 'read', 'poll']) {
    assert.deepEqual(
      await run(`l${how}`),
      ok(`jumped ${how}\nusr1=0 usr2=1 alrm=1\nagain=2\n`),
      how
    );
  }
});

test('a siglongjmp out of a WASIX signal handler lands at its sigsetjmp with the saved mask back, from raise, a blocking call, a flock wait and a forked child, and the next signal runs its handler (homescoop#1059)', {
  timeout: 120_000,
}, async (t) => {
  const run = await booted(t);
  const after = 'usr1=0 usr2=0 alrm=0\nagain=2\n';
  assert.deepEqual(await run('direct'), ok('direct jumped\n'));
  assert.deepEqual(await run('directmask'), ok('direct jumped\n'));
  assert.deepEqual(await run('raise'), ok(`jumped\n${after}`));
  for (const how of ['sleep', 'nanosleep', 'read', 'poll']) {
    assert.deepEqual(await run(how), ok(`jumped ${how}\n${after}`), how);
  }
  assert.deepEqual(await run('fork'), ok(`child jumped\n${after}child status 0\n`));
  const holder = run('hold');
  while (!(await run.held())) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await run('flock'), ok(`jumped flock\n${after}`));
  assert.deepEqual(await holder, ok('held\n'));
});
