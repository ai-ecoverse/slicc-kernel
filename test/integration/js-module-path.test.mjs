import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const MAIN = `const probe = async (ctx) => {
  const path = ctx.module?.path;
  const dir = path.slice(0, path.lastIndexOf('/'));
  return {
    path,
    frozen: Object.isFrozen(ctx.module),
    sibling: new TextDecoder().decode(await ctx.fs.readFile(dir + '/vendor/lib.cjs')),
  };
};
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    ctx.thread.port.postMessage(await probe(ctx));
    await new Promise(() => {});
  }
  const out = { process: await probe(ctx) };
  const t = await ctx.thread.spawn({});
  out.thread = await new Promise((resolve) => {
    t.port.onmessage = (e) => resolve(e.data);
  });
  await t.terminate();
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

const ONE = {
  path: '/node_modules/mp/dist/main.mjs',
  frozen: true,
  sibling: 'module.exports = 1;',
};
const WANT = { process: ONE, thread: ONE };
const PKG = JSON.stringify({
  name: 'mp',
  slicc: { commands: { mp: { abi: 'js', module: 'dist/main.mjs' } } },
});

test("ctx.module.path on Node is the command module's kernel path, in a process and a thread, and its directory reaches the package's own files (#1598)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/mp/package.json', PKG);
  await kernel.writeFile('/node_modules/mp/dist/main.mjs', MAIN);
  await kernel.writeFile('/node_modules/mp/dist/vendor/lib.cjs', 'module.exports = 1;');
  const r = await kernel.run(['mp'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), WANT);
});

test("ctx.module.path in a page is the command module's kernel path, in a process and a thread (#1598)", async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page } = await bootedPage(chrome, t);
  const r = await page.evaluate(
    async ({ pkg, main }) => {
      await window.opfs.write('node_modules/mp/package.json', pkg);
      await window.opfs.write('node_modules/mp/dist/main.mjs', main);
      await window.opfs.write('node_modules/mp/dist/vendor/lib.cjs', 'module.exports = 1;');
      return window.kernel.run(['mp'], { cwd: '/' });
    },
    { pkg: PKG, main: MAIN }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), WANT);
});
