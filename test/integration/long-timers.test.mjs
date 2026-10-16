import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/longwait/', import.meta.url);

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/longwait.wasm']) {
    await kernel.writeFile(
      `/node_modules/longwait/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  const overflows = [];
  const watch = (warning) => {
    if (warning.name === 'TimeoutOverflowWarning') overflows.push(warning.message);
  };
  process.on('warning', watch);
  t.after(() => process.off('warning', watch));
  return { kernel, overflows };
}

test('alarm(3000000) does not fire at once: a timer over 2^31-1 ms waits its time (#767)', async (t) => {
  const { kernel, overflows } = await booted(t);
  const r = await kernel.run(['longwait', 'alarm'], { cwd: '/' });
  assert.match(r.stdout, /^alarm\(3000000\): 0 alarms after 0\.5 s, (2999999|3000000) s left\n$/);
  assert.deepEqual(overflows, []);
});

for (const mode of ['select', 'ppoll', 'nanosleep']) {
  test(`a ${mode} with a timeout over 2^31-1 ms sleeps until a signal wakes it, without re-arming an overflowed timer (#767)`, async (t) => {
    const { kernel, overflows } = await booted(t);
    const r = await kernel.run(['longwait', mode], { cwd: '/' });
    assert.equal(
      r.stdout,
      `${mode}: -1 Interrupted system call after the 300 ms alarm, not before it\n`
    );
    assert.deepEqual(overflows, []);
  });
}
