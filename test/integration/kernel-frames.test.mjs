import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROBE = `const probe = async (ctx, name) => {
  const stacks = [];
  stacks.push(new Error('main').stack);
  try {
    await ctx.fs.readFile('/no/such/file');
  } catch (err) {
    stacks.push(String(err.stack));
  }
  try {
    ctx.sync.fs.readFile('/no/such/file');
  } catch (err) {
    stacks.push(String(err.stack));
  }
  if (ctx.sync.runScript('1') !== undefined) {
    try {
      ctx.sync.runScript('throw new Error("script")', { filename: 'script.js' });
    } catch (err) {
      stacks.push(String(err.stack));
    }
  }
  const before = Error.prepareStackTrace;
  Error.prepareStackTrace = (_e, sites) => sites.map((s) => String(s)).join('\\n');
  const custom = new Error('custom').stack;
  Error.prepareStackTrace = before;
  const all = stacks.join('\\n') + '\\n' + custom;
  return {
    named: stacks.every((s) => s.includes('slicc-kernel:/' + name)) && custom.includes('slicc-kernel:/' + name),
    leaked: all.split('\\n').filter((l) => /(file|https?):\\/\\/\\S*(node-)?process-worker\\.js/.test(l)),
  };
};
`;

const MAIN = `${PROBE}
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    ctx.thread.port.postMessage(await probe(ctx, 'node-process-worker.js'));
    await new Promise(() => {});
  }
  if (ctx.argv[1] === 'thread') {
    const t = await ctx.thread.spawn({});
    const got = await new Promise((resolve) => {
      t.port.onmessage = (e) => resolve(e.data);
    });
    await t.terminate();
    await ctx.write(1, JSON.stringify(got));
    return 0;
  }
  await ctx.write(1, JSON.stringify(await probe(ctx, ctx.argv[2] ?? 'node-process-worker.js')));
  return 0;
}
`;

for (const where of ['process', 'thread']) {
  test(`on Node, in a ${where}, the kernel's own frames in a program's stacks are named slicc-kernel:/node-process-worker.js, not the host's file URL: in its own errors, a failed ctx call, sync.fs and runScript, and for a program's own prepareStackTrace (#1583)`, async (t) => {
    const kernel = await createNodeKernel({ users: 'off' });
    t.after(() => kernel.terminate());
    await kernel.writeFile(
      '/node_modules/kf/package.json',
      JSON.stringify({ name: 'kf', slicc: { commands: { kf: { abi: 'js', module: 'main.mjs' } } } })
    );
    await kernel.writeFile('/node_modules/kf/main.mjs', MAIN);
    const r = await kernel.run(['kf', where], { cwd: '/' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { named: true, leaked: [] });
  });
}
