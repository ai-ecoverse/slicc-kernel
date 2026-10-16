import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/killspin/', import.meta.url);

for (const signal of ['SIGKILL', 'SIGTERM']) {
  test(`${signal} ends a WASI program that swallows the kill and keeps calling the kernel (#755)`, async (t) => {
    const kernel = await createNodeKernel();
    t.after(() => kernel.terminate());
    for (const file of ['package.json', 'bin/killspin.wasm']) {
      await kernel.writeFile(
        `/node_modules/killspin/${file}`,
        await readFile(new URL(file, fixture))
      );
    }
    let shown = '';
    const term = await kernel.openTerminal(['killspin'], {
      cwd: '/',
      onData: (bytes) => {
        shown += new TextDecoder().decode(bytes);
      },
    });
    while (!shown.includes('spinning')) await new Promise((resolve) => setTimeout(resolve, 10));
    term.signal(signal);
    const late = new Promise((resolve) =>
      setTimeout(() => resolve('still running after 8 s'), 8000)
    );
    assert.deepEqual(await Promise.race([term.ended, late]), {
      status: signal === 'SIGKILL' ? 137 : 143,
      signal,
    });
  });
}
