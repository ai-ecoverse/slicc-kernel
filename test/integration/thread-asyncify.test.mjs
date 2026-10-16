import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/threadjmp/', import.meta.url);

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/threadjmp.wasm', 'bin/threadjmp-pie.wasm']) {
    await kernel.writeFile(
      `/node_modules/threadjmp/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  return kernel;
}

test('a WASIX thread longjmps through Asyncify and forks, its child forks again, and the main thread keeps its own deep stack (#710)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['threadjmp'], { cwd: '/' }), {
    status: 0,
    stdout: [
      'thread jumps=50',
      'child of the thread jumps=50',
      'its child exit=4',
      'thread child exit=3',
      'main damaged=0',
      '',
    ].join('\n'),
    stderr: '',
  });
});

test('a thread of a position-independent WASIX program forks, while the main thread keeps its own deep stack (#710)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['threadjmp-pie'], { cwd: '/' }), {
    status: 0,
    stdout: [
      'child of the thread jumps=0',
      'its child exit=4',
      'thread child exit=3',
      'main damaged=0',
      '',
    ].join('\n'),
    stderr: '',
  });
});
