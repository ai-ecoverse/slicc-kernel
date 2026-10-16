import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/maskentry/', import.meta.url);

test('a signal delivered as a masked wait is entered, which the wait mask blocks, does not end the wait with EINTR; one it leaves unblocked does (#799)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/maskentry.wasm']) {
    await kernel.writeFile(
      `/node_modules/maskentry/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  assert.deepEqual(await kernel.run(['maskentry'], { cwd: '/' }), {
    status: 0,
    stdout: [
      'sigmask_poll, the mask blocks SIGALRM: ok, events 1, handled 1, after the timeout',
      'sigmask_poll, the mask leaves SIGALRM: Interrupted system call, events 0, handled 1, before the timeout',
      'sigmask_epoll_wait, the mask blocks SIGALRM: ok, events 0, handled 1, after the timeout',
      'sigmask_epoll_wait, the mask leaves SIGALRM: Interrupted system call, events 0, handled 1, before the timeout',
      '',
    ].join('\n'),
    stderr: '',
  });
});
