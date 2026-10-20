import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('./fixtures/handlertest/', import.meta.url);

test('a WASIX signal is held while its own handler runs and delivered once after it returns, unless SA_NODEFER (#971)', {
  timeout: 60_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/handlertest.wasm']) {
    await kernel.writeFile(
      `/node_modules/handlertest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  assert.deepEqual(await kernel.run(['handlertest'], { cwd: '/' }), {
    status: 0,
    stdout: 'the handler ran 2 times, at most 1 deep\n',
    stderr: 'the handler wrote\n',
  });
  assert.deepEqual(await kernel.run(['handlertest', 'nodefer'], { cwd: '/' }), {
    status: 0,
    stdout: 'the handler ran 2 times, at most 2 deep\n',
    stderr: 'the handler wrote\n',
  });
});

const nest = new URL('./fixtures/nesttest/', import.meta.url);

test('a handler that unblocks its own signal and raises it nests at once, as on Linux (#1236, homescoop#1058)', {
  timeout: 60_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/nesttest.wasm']) {
    await kernel.writeFile(`/node_modules/nesttest/${file}`, await readFile(new URL(file, nest)));
  }
  assert.deepEqual(await kernel.run(['nesttest'], { cwd: '/' }), {
    status: 0,
    stdout: 'order=<<>> maxdepth=2\n',
    stderr: '',
  });
});
