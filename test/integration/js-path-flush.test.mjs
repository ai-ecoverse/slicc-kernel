import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = readFileSync(new URL('fixtures/jsflush/bin/jsflush.mjs', import.meta.url), 'utf8');

test("a JS program's path stat, lstat and readFile see its own bytes and mtime written through an fd it still holds, in the main thread and in a thread (#1594)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/jsflush/package.json',
    JSON.stringify({
      name: 'jsflush',
      slicc: { commands: { jsflush: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/jsflush/main.mjs', PROGRAM);
  const r = await kernel.run(['jsflush'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  const want = { first: [5, 'hello', true], second: [11, 'hello world'], third: [12, 12] };
  assert.deepEqual(JSON.parse(r.stdout), { main: want, thread: want });
});
