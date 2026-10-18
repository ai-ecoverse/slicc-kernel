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
  return (mode) => kernel.run(['sigjmptest', mode], { cwd: '/tmp' });
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
