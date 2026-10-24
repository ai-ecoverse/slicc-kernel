import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = readFileSync(
  new URL('fixtures/jsdevprobe/bin/jsdevprobe.mjs', import.meta.url),
  'utf8'
);

test('a JS path op through a symlink into /dev, or a symlinked dir, still reaches the device, and a missing path costs one kernel call (#1595)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/jsdevprobe/package.json',
    JSON.stringify({
      name: 'jsdevprobe',
      slicc: { commands: { jsdevprobe: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/jsdevprobe/main.mjs', PROGRAM);
  const r = await kernel.run(['jsdevprobe'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.link.slice(1), [true, 0]);
  assert.deepEqual(got.dir.slice(1), [true, 0]);
  assert.deepEqual(got.async.slice(1), [true, 0]);
  assert.deepEqual(got.errors, ['ENOENT', 'ENOENT', false]);
  assert.deepEqual(got.calls, [1, 1, 1, 1]);
});
