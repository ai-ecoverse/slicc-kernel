import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PACKAGE = JSON.stringify({
  name: 'counted',
  slicc: { commands: { counted: { abi: 'js', module: 'bin/counted.mjs' } } },
});

const program = (tag) => `let calls = 0;
export default async function main(ctx) {
  calls++;
  await ctx.write(1, '${tag} ' + calls + '\\n');
}
`;

test('each spawn of a JS command gets fresh module state, and a changed module is picked up', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/counted/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/counted/bin/counted.mjs', program('first'));
  const run = async () => (await kernel.run(['counted'], { cwd: '/' })).stdout;
  assert.equal(await run(), 'first 1\n');
  assert.equal(await run(), 'first 1\n');
  const both = await Promise.all([run(), run()]);
  assert.deepEqual(both, ['first 1\n', 'first 1\n']);
  await kernel.writeFile('/node_modules/counted/bin/counted.mjs', program('second'));
  assert.equal(await run(), 'second 1\n');
  await kernel.writeFile('/node_modules/counted/bin/counted.mjs', program('first'));
  assert.equal(await run(), 'first 1\n');
});
