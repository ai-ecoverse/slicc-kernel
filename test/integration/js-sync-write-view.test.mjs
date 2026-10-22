import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = `export default async (ctx) => {
  const backing = new Uint8Array(512 * 1024 * 1024);
  const tail = backing.subarray(backing.length - 3 * 1024 * 1024 - 5);
  for (let i = 0; i < tail.length; i++) tail[i] = (i * 31) & 255;
  const f = ctx.sync.open('/w/out', { write: true, create: true, truncate: true });
  const n = f.write(0, tail);
  f.close();
  await ctx.write(1, String(n));
  return 0;
};`;

test('a sync write of a view sends only its own bytes, not its whole backing buffer: 3 MiB from the end of a 512 MiB buffer land intact while the host grows by far less than the buffer (#1429)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/w/package.json',
    JSON.stringify({ name: 'w', slicc: { commands: { w: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/w/main.mjs', PROGRAM);
  await kernel.writeFile('/w/.keep', '');
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  const r = await kernel.run(['w'], { cwd: '/' });
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  const size = 3 * 1024 * 1024 + 5;
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, String(size), '']);
  const expected = new Uint8Array(size);
  for (let i = 0; i < size; i++) expected[i] = (i * 31) & 255;
  const got = await kernel.readFile('/w/out');
  assert.equal(
    createHash('sha256').update(got).digest('hex'),
    createHash('sha256').update(expected).digest('hex')
  );
  assert.ok(
    peak - before < 256 * 1024 * 1024,
    `the host grew by ${Math.round((peak - before) / 1e6)} MB`
  );
});
