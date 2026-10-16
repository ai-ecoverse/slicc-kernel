import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/epollmask/', import.meta.url);

test('slicc.sigmask_epoll_wait swaps the mask for the wait atomically: a pending or arriving signal it unblocks ends the wait, and the old mask is back after (#771)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/epollmask.wasm']) {
    await kernel.writeFile(
      `/node_modules/epollmask/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  assert.deepEqual(await kernel.run(['epollmask'], { cwd: '/' }), {
    status: 0,
    stdout: [
      'pending SIGUSR1, unblocked by the call: Interrupted system call, handled 1, events 0, at once',
      'nothing ready, 200 ms: ok, events 0, on time',
      'SIGALRM during the wait, unblocked by the call: Interrupted system call, handled 1, events 0, on time',
      'one ready: ok, events 1',
      'after the call SIGUSR1 is blocked again: pending, handled 2',
      '',
    ].join('\n'),
    stderr: '',
  });
});
