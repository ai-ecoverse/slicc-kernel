import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('while another kernel shares the root, a WASI thread sees that kernel’s change to a file at once, not its cached stat (#959, #1006)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(async () => {
    for (const name of ['package.json', 'bin/excltest.wasm']) {
      const bytes = await (await fetch(`/fixtures/excltest/${name}`)).arrayBuffer();
      await window.opfs.write(`node_modules/excltest/${name}`, bytes);
    }
  });
  assert.deepEqual(
    await bash('rm -rf /tmp/xw && mkdir -p /tmp/xw && echo a > /tmp/xw/f', { cwd: '/' }),
    ok()
  );
  const [reader, writer] = await page.evaluate(async () => {
    await window.secondKernel({});
    return Promise.all([
      window.kernel.run(['excltest', 'watch', '/tmp/xw/f', '/tmp/xw/ready', '/tmp/xw/done'], {
        cwd: '/',
      }),
      window.second.run(
        [
          'bash',
          '-c',
          'while [ ! -e /tmp/xw/ready ]; do sleep 0.05; done; echo bb >> /tmp/xw/f && touch /tmp/xw/done',
        ],
        { cwd: '/' }
      ),
    ]);
  });
  assert.deepEqual(writer, ok());
  assert.deepEqual(reader, ok('fresh\n'));
});
