import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { asyncKernel, clientOf, MODE_NAMES, spawnReady, within } from './async-link-kernel.mjs';
import { closes } from './async-link-process.mjs';

for (const mode of ['inline', 'thread']) {
  describe(`async process failures over ${MODE_NAMES[mode]}`, () => {
    test('a process that fails reports its error', async (t) => {
      const kernel = await asyncKernel(mode);
      t.after(() => kernel.terminate());
      const r = await within(kernel.run(['fake', 'fail']), 5000, 'run');
      assert.equal(r.status, 70);
      assert.match(r.stderr, /deliberate failure/);
    });

    const vanishing = mode === 'thread' ? [['vanish'], ['vanish', 'exit']] : [['vanish']];
    for (const args of vanishing) {
      test(`a process that vanishes (${args.join(' ')}) ends with an error`, async (t) => {
        const kernel = await asyncKernel(mode);
        t.after(() => kernel.terminate());
        const r = await within(kernel.run(['fake', ...args]), 5000, 'run');
        assert.equal(r.status, 70);
        assert.equal(r.stdout, 'ready\n');
        assert.match(r.stderr, /the async process link closed/);
      });
    }

    test('kernel terminate() ends a running remote process', async () => {
      const kernel = await asyncKernel(mode);
      const client = await clientOf(kernel);
      const { ready } = await spawnReady(client, ['fake', 'hang']);
      await within(ready, 5000, 'ready');
      const before = closes.length;
      const running = kernel.run(['fake', 'hang']);
      await new Promise((resolve) => setTimeout(resolve, 100));
      kernel.terminate();
      await assert.rejects(within(running, 5000, 'run'), /the kernel is terminated/);
      if (mode === 'inline') {
        for (let i = 0; i < 50 && closes.length < before + 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(closes.length >= before + 2, `closes ${closes.length - before}`);
      }
    });

    test('a thread spawn is refused with a clear error', async (t) => {
      const kernel = await asyncKernel(mode);
      t.after(() => kernel.terminate());
      const r = await within(kernel.run(['fake', 'thread']), 5000, 'run');
      assert.equal(r.status, 70);
      assert.match(r.stderr, /runs no threads/);
    });

    test('a JS program is refused with a clear error', async (t) => {
      const kernel = await asyncKernel(mode);
      t.after(() => kernel.terminate());
      await kernel.writeFile(
        '/node_modules/jsprog/package.json',
        JSON.stringify({ slicc: { abi: 'js', commands: { jsprog: { module: 'main.js' } } } })
      );
      await kernel.writeFile('/node_modules/jsprog/main.js', 'export default () => 0;');
      const r = await within(kernel.run(['jsprog']), 5000, 'run');
      assert.equal(r.status, 126);
      assert.match(r.stderr, /runs no JS programs/);
    });
  });
}
