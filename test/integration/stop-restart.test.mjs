import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/stopwait/', import.meta.url);

const rows = [
  ['epoll', '-1 Interrupted system call, before the deadline'],
  ['poll', '0 ok, at the deadline'],
  ['ppoll', '0 ok, at the deadline'],
  ['select', '0 ok, at the deadline'],
  ['pselect', '0 ok, at the deadline'],
  ['nanosleep', '0 ok, at the deadline'],
  ['clock_nanosleep', '0 ok, at the deadline'],
];

for (const [call, outcome] of rows) {
  test(`a 300 ms ${call} stopped for 200 ms and continued ends as on Linux (${outcome.includes('Interrupted') ? 'EINTR' : 'at its deadline'})`, async (t) => {
    const kernel = await createNodeKernel();
    t.after(() => kernel.terminate());
    for (const file of ['package.json', 'bin/stopwait.wasm']) {
      await kernel.writeFile(
        `/node_modules/stopwait/${file}`,
        await readFile(new URL(file, fixture))
      );
    }
    assert.deepEqual(await kernel.run(['stopwait', call], { cwd: '/' }), {
      status: 0,
      stdout: `${call} ${outcome}\n`,
      stderr: '',
    });
  });
}
