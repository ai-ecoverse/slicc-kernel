import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/sigwaittest/', import.meta.url);

test('slicc.sigwait takes a pending signal of its set, times out with EAGAIN, ends with EINTR for a handled signal, and takes a process-directed signal every thread blocks (#520)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/sigwaittest.wasm']) {
    await kernel.writeFile(
      `/node_modules/sigwaittest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  assert.deepEqual(await kernel.run(['sigwaittest'], { cwd: '/' }), {
    status: 0,
    stdout: [
      'pending SIGUSR1: ok, took 10, handler ran 0 times',
      'nothing pending, 200 ms: Resource temporarily unavailable, took 0, on time',
      'SIGALRM with a handler during the wait: Interrupted system call, took 0, alarm handled 1',
      'SIGALRM came while computing, handled on entry: Interrupted system call, took 0, alarm handled 1, at once',
      'SIGTERM blocked everywhere, sigwaited by a thread: ok, took 15, the process runs on',
      '',
    ].join('\n'),
    stderr: '',
  });
});
