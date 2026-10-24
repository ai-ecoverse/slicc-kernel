import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const MAIN = `export default async function main(ctx) {
  const url = import.meta.url;
  const tries = {};
  for (const spec of ['slicc-module:' + '0'.repeat(64), 'slicc-module:nope', './sibling.mjs', 'node:fs']) {
    try {
      await import(spec);
      tries[spec] = 'loaded';
    } catch (err) {
      tries[spec] = err.code ?? err.name;
    }
  }
  const out = { scheme: url.split(':')[0], short: url.length < 100, hostPath: /Users|home|private|file:/.test(url), tries };
  if (ctx.thread.tid !== 0) {
    ctx.thread.port.postMessage(out);
    await new Promise(() => {});
  }
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
  scheme: 'slicc-module',
  short: true,
  hostPath: false,
  tries: {
    ['slicc-module:' + '0'.repeat(64)]: 'ERR_ACCESS_DENIED',
    'slicc-module:nope': 'ERR_ACCESS_DENIED',
    './sibling.mjs': 'ERR_UNSUPPORTED_RESOLVE_REQUEST',
    'node:fs': 'ERR_ACCESS_DENIED',
  },
};

test("on Node a command module reaches its worker as source under a short slicc-module: URL with no host path, in a process and a thread; a slicc-module: id the kernel didn't hand over, a relative import (as from a data: URL) and a builtin are refused (#1596)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/ms/package.json',
    JSON.stringify({ name: 'ms', slicc: { commands: { ms: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/ms/main.mjs', MAIN);
  await kernel.writeFile('/node_modules/ms/sibling.mjs', 'export default 1;');
  const r = await kernel.run(['ms'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ...ONE, thread: ONE });
});
