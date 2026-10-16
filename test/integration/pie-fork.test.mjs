import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/piefork/', import.meta.url);

test('a position-independent WASIX program forked from deep in its stack keeps its data and its frames, in the parent and the child (#708)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/piefork.wasm']) {
    await kernel.writeFile(`/node_modules/piefork/${file}`, await readFile(new URL(file, fixture)));
  }
  assert.deepEqual(await kernel.run(['piefork'], { cwd: '/' }), {
    status: 0,
    stdout: [
      'child pattern=0 low=0 frames=0',
      'child exit=7',
      'parent pattern=0 low=0 frames=0',
      '',
    ].join('\n'),
    stderr: '',
  });
});
