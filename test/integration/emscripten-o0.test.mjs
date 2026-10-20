import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const FILES = ['package.json', 'bin/emo0', 'bin/emo0.wasm'];
const fixture = new URL('fixtures/emo0/', import.meta.url);
const HELLO = { status: 0, stdout: 'hello from an -O0 emcc build, 2 args\n', stderr: '' };

test("an emcc -O0 program (ASSERTIONS, ENVIRONMENT web,worker,node) runs on the Node entry: its glue reads the process worker as a worker, not a JS shell, and Node's process stays hidden (#1238, homescoop#1065)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const file of FILES) {
    await kernel.writeFile(`/node_modules/emo0/${file}`, await readFile(new URL(file, fixture)));
  }
  assert.deepEqual(await kernel.run(['emo0', 'a', 'b'], { cwd: '/' }), HELLO);
  await kernel.writeFile(
    '/node_modules/probe/package.json',
    JSON.stringify({
      name: 'probe',
      slicc: { commands: { probe: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile(
    '/node_modules/probe/main.mjs',
    "export default async (ctx) => { await ctx.write(1, [typeof process, typeof WorkerGlobalScope, typeof location].join(' ')); }"
  );
  assert.equal(
    (await kernel.run(['probe'], { cwd: '/' })).stdout,
    'undefined undefined undefined',
    'a JS program sees no worker shape and no process'
  );
});

test('the same emcc -O0 program runs in the page', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page, run } = await bootedPage(chrome, t);
  await page.evaluate(async (files) => {
    for (const name of files) {
      const bytes = await (await fetch(`/fixtures/emo0/${name}`)).arrayBuffer();
      await window.opfs.write(`node_modules/emo0/${name}`, bytes);
    }
  }, FILES);
  assert.deepEqual(await run(['emo0', 'a', 'b'], { cwd: '/' }), HELLO);
});
