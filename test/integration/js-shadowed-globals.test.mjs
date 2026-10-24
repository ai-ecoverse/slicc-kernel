import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const NAMES = [
  'setTimeout',
  'clearTimeout',
  'Promise',
  'queueMicrotask',
  'AbortController',
  'TextEncoder',
  'TextDecoder',
  'Atomics',
  'Map',
  'Set',
  'Uint8Array',
  'performance',
];

const MAIN = `const NAMES = ${JSON.stringify(NAMES)};
const shadow = (ctx, how) => {
  if (how === 'let' && ctx.sync.runScript('1') !== undefined) {
    ctx.sync.runScript('const ' + NAMES.map((n, i) => n + ' = ' + (i + 1)).join(', ') + ';', { filename: 'shadow.js' });
  } else {
    for (const n of NAMES) globalThis[n] = 2;
  }
};
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    const port = ctx.thread.port;
    shadow(ctx, ctx.thread.data.how);
    await ctx.write(1, 'thread wrote\\n');
    port.postMessage('done');
    return 0;
  }
  const [where, how] = [ctx.argv[1], ctx.argv[2]];
  if (where === 'thread') {
    const t = await ctx.thread.spawn({ data: { how } });
    await new Promise((resolve) => {
      t.port.onmessage = resolve;
    });
    await ctx.write(1, 'main after thread\\n');
    return 0;
  }
  await ctx.write(1, 'before\\n');
  shadow(ctx, how);
  ctx.write(1, 'after\\n');
  return 0;
}
`;

const WANT = {
  process: 'before\nafter\n',
  thread: 'thread wrote\nmain after thread\n',
};

async function install(kernel) {
  await kernel.writeFile(
    '/node_modules/sg/package.json',
    JSON.stringify({ name: 'sg', slicc: { commands: { sg: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/sg/main.mjs', MAIN);
}

for (const where of ['process', 'thread']) {
  for (const how of ['let', 'assign']) {
    test(`on Node, in a ${where}, a program that ${how === 'let' ? 'declares global lets' : 'assigns globalThis properties'} named setTimeout, Promise, queueMicrotask, AbortController and other globals the kernel uses still exits normally with its output flushed (#1586)`, async (t) => {
      const kernel = await createNodeKernel({ users: 'off' });
      t.after(() => kernel.terminate());
      await install(kernel);
      const r = await kernel.run(['sg', where, how], { cwd: '/' });
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, WANT[where], '']);
    });
  }
}

test('in a page, a program that assigns globalThis properties the kernel uses still exits normally with its output flushed, in a process and a thread (#1586)', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page } = await bootedPage(chrome, t);
  const r = await page.evaluate(async (main) => {
    await window.opfs.write(
      'node_modules/sg/package.json',
      JSON.stringify({ name: 'sg', slicc: { commands: { sg: { abi: 'js', module: 'main.mjs' } } } })
    );
    await window.opfs.write('node_modules/sg/main.mjs', main);
    const out = [];
    for (const where of ['process', 'thread'])
      out.push(await window.kernel.run(['sg', where, 'assign'], { cwd: '/' }));
    return out;
  }, MAIN);
  assert.deepEqual(
    r.map((x) => [x.status, x.stdout, x.stderr]),
    [
      [0, WANT.process, ''],
      [0, WANT.thread, ''],
    ]
  );
});
