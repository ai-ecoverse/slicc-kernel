import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const PACKAGE = JSON.stringify({
  name: 'jsmemory',
  slicc: { commands: { jsmemory: { abi: 'js', module: 'main.mjs' } } },
});
const program = () => readFile(new URL('fixtures/jsmemory/main.mjs', import.meta.url), 'utf8');

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/jsmemory/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/jsmemory/main.mjs', await program());
  return async (arg) => {
    const r = await kernel.run(['jsmemory', arg], { cwd: '/' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
}

test("ctx.memory() on the Node entry: the calling isolate's heapUsed, heapTotal and heapLimit in bytes, a fresh plain object of numbers each call, no rss, and Node's process still out of reach (#1240)", async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('shape'), {
    keys: [],
    numbers: true,
    plain: true,
    fresh: true,
    rss: false,
    positive: [true, true, true],
    process: 'undefined',
    viaFunction: 'undefined',
  });
});

test("ctx.memory() in a ctx.thread answers for that thread: its heapUsed rises with what it allocates, and the main thread's does not (#1240)", async (t) => {
  const run = await booted(t);
  const r = await run('threads');
  assert.equal(r.threadGrew, true, JSON.stringify(r.deltas));
  assert.equal(r.mainStill, true, JSON.stringify(r.deltas));
});

test('ctx.memory() in the page measures nothing yet and answers {} (#1240)', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page, run } = await bootedPage(chrome, t);
  await page.evaluate(async (pkg) => {
    await window.opfs.write('node_modules/jsmemory/package.json', pkg);
    await window.opfs.write(
      'node_modules/jsmemory/main.mjs',
      'export default async (ctx) => { await ctx.write(1, JSON.stringify(ctx.memory())); }'
    );
  }, PACKAGE);
  const r = await run(['jsmemory'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '{}');
});
