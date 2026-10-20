import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = `export default async function main(ctx) {
  setTimeout(() => { throw new Error('nobody listens'); }, 0);
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 200; i++) await ctx.write(1, 'x');
  return 0;
}
`;

test('a JS program whose uncaught error nobody listens for writes nothing after it: the process fails with the error and no later output (#1186 hook flake)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/strays/package.json',
    JSON.stringify({
      name: 'strays',
      slicc: { commands: { strays: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/strays/main.mjs', PROGRAM);
  for (let i = 0; i < 5; i++) {
    const r = await kernel.run(['strays'], { cwd: '/' });
    assert.deepEqual(
      { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) },
      { status: 1, stdout: '', stderr: 'strays: nobody listens\n' }
    );
  }
});
