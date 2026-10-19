import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import * as testing from '../../dist/testing.js';

const PROGRAM = `export default async function main(ctx) {
  await ctx.write(1, 'umask ' + (await ctx.umask()) + '\\n');
}
`;

test('setTestSyscallHook (test-only) sees every kernel call of a program while set, can hold one, and is inert once cleared', {
  timeout: 60_000,
}, async (t) => {
  assert.equal(typeof testing.setTestSyscallHook, 'function');
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  t.after(() => testing.setTestSyscallHook(undefined));
  await kernel.writeFile(
    '/node_modules/hk/package.json',
    JSON.stringify({ name: 'hk', slicc: { commands: { hk: { abi: 'js', module: 'hk.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/hk/hk.mjs', PROGRAM);
  const seen = [];
  let held = 0;
  testing.setTestSyscallHook(async ({ pid, op }) => {
    seen.push(op);
    if (op === 'proc-umask' && held === 0) {
      held = Date.now();
      await new Promise((r) => setTimeout(r, 200));
      held = Date.now() - held;
    }
    assert.equal(typeof pid, 'number');
  });
  assert.deepEqual(await kernel.run(['hk'], { cwd: '/' }), {
    status: 0,
    stdout: 'umask 18\n',
    stderr: '',
  });
  assert.ok(seen.includes('proc-umask'), seen.join(','));
  assert.ok(held >= 190, String(held));
  testing.setTestSyscallHook(undefined);
  const before = seen.length;
  await kernel.run(['hk'], { cwd: '/' });
  assert.equal(seen.length, before);
});
