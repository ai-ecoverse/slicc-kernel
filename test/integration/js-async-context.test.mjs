import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const PACKAGE = JSON.stringify({
  name: 'als',
  slicc: { commands: { als: { abi: 'js', module: 'main.mjs' } } },
});

const PROGRAM = `export default async function main(ctx) {
  const ac = ctx.asyncContext;
  const out = {};
  if (ctx.argv[1] === 'other') {
    out.other = ac.getStore() ?? 'none';
    await ctx.write(1, JSON.stringify(out));
    return 0;
  }
  out.awaited = await ac.run('A', async () => { await null; await new Promise((r) => setTimeout(r, 5)); return ac.getStore(); });
  out.outside = ac.getStore() ?? 'none';
  out.nested = await ac.run('outer', async () => {
    const inner = await ac.run('inner', async () => { await null; return ac.getStore(); });
    await null;
    return [inner, ac.getStore()];
  });
  out.jobs = await ac.run('J', () => Promise.resolve().then(() => queueMicrotask) && new Promise((r) => queueMicrotask(() => r(ac.getStore()))));
  out.args = ac.run('S', (a, b) => [ac.getStore(), a + b], 2, 3);
  out.entered = await ac.run('E0', async () => { ac.enterWith('E1'); await null; return ac.getStore(); });
  const spawned = ac.run('mine', () => ctx.sync.run({ argv: ['als', 'other'] }));
  out.other = JSON.parse(new TextDecoder().decode(spawned.stdout)).other;
  const leaks = [];
  for (const name of ['run', 'getStore', 'enterWith']) {
    const fn = ac[name];
    if (Object.getPrototypeOf(fn) !== Function.prototype) leaks.push(name + ' proto');
    if (Object.getOwnPropertyNames(fn).some((k) => !['length', 'name'].includes(k))) leaks.push(name + ' props');
    if (!Object.isFrozen(fn)) leaks.push(name + ' not frozen');
  }
  if (Object.getPrototypeOf(ac) !== null) leaks.push('object proto');
  if (!Object.isFrozen(ac)) leaks.push('object not frozen');
  if (Object.keys(ac).sort().join() !== 'enterWith,getStore,run') leaks.push('keys ' + Object.keys(ac));
  try { ac.run = () => 'mine'; } catch {}
  if (ac.run('x', () => 1) !== 1) leaks.push('replaced');
  out.leaks = leaks;
  out.process = typeof process;
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

test("ctx.asyncContext on the Node entry: a store follows the program's native awaits and promise jobs, nests, takes enterWith, stays in its own program, and the three frozen wrappers lead to no host object (#1350, slicc-jsh#375)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/als/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/als/main.mjs', PROGRAM);
  const r = await kernel.run(['als'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    awaited: 'A',
    outside: 'none',
    nested: ['inner', 'outer'],
    jobs: 'J',
    args: ['S', 5],
    entered: 'E1',
    other: 'none',
    leaks: [],
    process: 'undefined',
  });
});

test('ctx.asyncContext is absent on the page entry, so a runtime feature-detects it (#1350)', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page, run } = await bootedPage(chrome, t);
  await page.evaluate(async (pkg) => {
    await window.opfs.write('node_modules/als/package.json', pkg);
    await window.opfs.write(
      'node_modules/als/main.mjs',
      "export default async (ctx) => { await ctx.write(1, String('asyncContext' in ctx)); }"
    );
  }, PACKAGE);
  const r = await run(['als'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'false');
});
