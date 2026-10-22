import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = `export default async (ctx) => {
  const f = await ctx.open('/w/f', { read: true });
  await ctx.fs.writeFile('/w/ready', '');
  while (!(await ctx.fs.exists('/w/go'))) await new Promise((r) => setTimeout(r, 5));
  try {
    const b = await f.read(0, 16);
    await ctx.write(1, 'read ' + b.length);
  } catch (err) {
    await ctx.write(1, 'error ' + err.code);
  }
  return 0;
};`;

test('a read through an open descriptor whose file was removed outside the kernel before its first read fails with EIO, as on Linux, not ENOENT (#1423)', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/v/package.json',
    JSON.stringify({ name: 'v', slicc: { commands: { v: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/v/main.mjs', PROGRAM);
  await kernel.writeFile('/w/f', 'old');
  const running = kernel.run(['v'], { cwd: '/' });
  while (
    !(await kernel.readFile('/w/ready').then(
      () => true,
      () => false
    ))
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await (await kernel.root.getDirectoryHandle('w')).removeEntry('f');
  await kernel.writeFile('/w/go', '');
  const r = await running;
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'error EIO', '']);
});

const HOLDER = `export default async (ctx) => {
  await ctx.open('/w/f', { read: true });
  await ctx.fs.writeFile('/w/held', '');
  while (!(await ctx.fs.exists('/w/done'))) await new Promise((r) => setTimeout(r, 5));
  return 0;
};`;

test('a read of a name another process holds open but has not read yet, after the file vanished outside the kernel, is still ENOENT, as for any name that is gone (#1423)', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/h/package.json',
    JSON.stringify({ name: 'h', slicc: { commands: { h: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/h/main.mjs', HOLDER);
  await kernel.writeFile(
    '/node_modules/c/package.json',
    JSON.stringify({ name: 'c', slicc: { commands: { c: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile(
    '/node_modules/c/main.mjs',
    `export default async (ctx) => {
      try {
        await ctx.fs.readFile('/w/f');
        await ctx.write(1, 'read');
      } catch (err) {
        await ctx.write(1, 'error ' + err.code);
      }
      return 0;
    };`
  );
  await kernel.writeFile('/w/f', 'old');
  const holding = kernel.run(['h'], { cwd: '/' });
  while (
    !(await kernel.readFile('/w/held').then(
      () => true,
      () => false
    ))
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await (await kernel.root.getDirectoryHandle('w')).removeEntry('f');
  const r = await kernel.run(['c'], { cwd: '/' });
  await kernel.writeFile('/w/done', '');
  assert.equal((await holding).status, 0);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'error ENOENT', '']);
});
