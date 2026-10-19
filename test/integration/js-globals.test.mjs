import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const NAMES = [
  'require',
  'module',
  'exports',
  '__filename',
  '__dirname',
  'importScripts',
  'postMessage',
  'Worker',
];

const PROGRAM = `const NAMES = ${JSON.stringify(NAMES)};
export default async function main(ctx) {
  const before = NAMES.map((n) => typeof globalThis[n]);
  const set = Object.fromEntries(NAMES.map((n, i) => [n, i + 1]));
  let thrown = null;
  try {
    Object.assign(globalThis, { self: globalThis, ...set });
  } catch (err) {
    thrown = String(err);
  }
  const read = NAMES.map((n) => globalThis[n]);
  for (const n of NAMES) delete globalThis[n];
  const after = NAMES.map((n) => typeof globalThis[n]);
  const hidden = [typeof process, typeof globalThis.global];
  await ctx.write(1, JSON.stringify({ before, thrown, read, after, hidden }));
  return 0;
}
`;

const WANT = {
  before: NAMES.map(() => 'undefined'),
  thrown: null,
  read: NAMES.map((_, i) => i + 1),
  after: NAMES.map(() => 'undefined'),
  hidden: ['undefined', 'undefined'],
};

const PACKAGE = JSON.stringify({
  name: 'globs',
  slicc: { commands: { globs: { abi: 'js', module: 'main.mjs' } } },
});

test("a JS program can assign its own require, module, Worker, importScripts and postMessage, as napi-rs's wasi worker template does, and deleting them brings back undefined, never Node's (createNodeKernel)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/globs/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/globs/main.mjs', PROGRAM);
  const r = await kernel.run(['globs'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), WANT);
});

test('in the page, a JS program can assign its own importScripts, postMessage and Worker too, and deleting them brings back undefined, not the worker scope', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page, run } = await bootedPage(chrome, t);
  await page.evaluate(
    async (pkg, program) => {
      await window.opfs.write('node_modules/globs/package.json', pkg);
      await window.opfs.write('node_modules/globs/main.mjs', program);
    },
    PACKAGE,
    PROGRAM
  );
  const r = await run(['globs'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), WANT);
});
