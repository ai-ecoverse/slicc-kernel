import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = `export default async function main(ctx) {
  const seen = globalThis.leftover ?? 'none';
  globalThis.leftover = ctx.argv[1];
  await ctx.write(1, JSON.stringify({ seen, pid: ctx.pid, env: ctx.env.WHO, cwd: ctx.cwd, process: typeof process, worker: typeof Worker }));
  return 0;
}
`;

const PACKAGE = JSON.stringify({
  name: 'warm',
  slicc: { commands: { warm: { abi: 'js', module: 'main.mjs' } } },
});

test('a JS program on the Node entry gets a fresh worker every spawn, warm or not: nothing one program left in its worker reaches the next, and pid, env and cwd are its own (#1341)', async (t) => {
  for (const warmWorker of [true, false]) {
    const kernel = await createNodeKernel({ users: 'off', warmWorker });
    t.after(() => kernel.terminate());
    await kernel.writeFile('/node_modules/warm/package.json', PACKAGE);
    await kernel.writeFile('/node_modules/warm/main.mjs', PROGRAM);
    await kernel.writeFile('/tmp/b/.keep', '');
    const a = JSON.parse(
      (await kernel.run(['warm', 'first'], { cwd: '/', env: { WHO: 'a' } })).stdout
    );
    const b = JSON.parse(
      (await kernel.run(['warm', 'second'], { cwd: '/tmp/b', env: { WHO: 'b' } })).stdout
    );
    assert.equal(a.seen, 'none', `warmWorker ${warmWorker}`);
    assert.equal(
      b.seen,
      'none',
      `warmWorker ${warmWorker}: the second spawn saw nothing of the first`
    );
    assert.notEqual(a.pid, b.pid);
    assert.deepEqual([a.env, b.env, a.cwd, b.cwd], ['a', 'b', '/', '/tmp/b']);
    assert.deepEqual([b.process, b.worker], ['undefined', 'undefined']);
  }
});

test('a host with a warm worker exits on its own without terminate(), and after terminate() nothing is left running (#1341)', async (t) => {
  const script = join(tmpdir(), `slicc-warm-${process.pid}.mjs`);
  t.after(() => rm(script, { force: true }));
  const dist = new URL('../../dist/node.js', import.meta.url).href;
  await writeFile(
    script,
    `const { createNodeKernel } = await import(${JSON.stringify(dist)});
const k = await createNodeKernel({ users: 'off' });
await k.writeFile('/node_modules/warm/package.json', ${JSON.stringify(PACKAGE)});
await k.writeFile('/node_modules/warm/main.mjs', 'export default async () => 0;');
console.log((await k.run(['warm'], { cwd: '/' })).status);
await new Promise((r) => setTimeout(r, 100));
if (process.argv[2] === 'terminate') k.terminate();
`
  );
  for (const mode of ['keep', 'terminate']) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [script, mode], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '0');
    assert.ok(Date.now() - started < 15_000, `${mode}: the host exited on its own`);
  }
});

test("a worker the host can't construct fails the spawn, and the warm refill behind it never throws out of the host (#1343 review)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off', worker: 'worker.js' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/warm/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/warm/main.mjs', 'export default async () => 0;');
  let uncaught;
  const seen = (err) => {
    uncaught = err;
  };
  process.on('uncaughtException', seen);
  t.after(() => process.off('uncaughtException', seen));
  await assert.rejects(kernel.run(['warm'], { cwd: '/' }), /worker script or module filename/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(uncaught, undefined, String(uncaught));
});

test('warmWorkers: n keeps up to n spares for a burst of starts, each still a fresh worker; it must be an integer from 0 to 64, and warmWorker: false still means none (#1361)', async (t) => {
  const kernel = await createNodeKernel({ users: 'off', warmWorkers: 8 });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/warm/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/warm/main.mjs', PROGRAM);
  await kernel.run(['warm', 'boot'], { cwd: '/' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      kernel.run(['warm', `b${i}`], { cwd: '/', env: { WHO: `w${i}` } })
    )
  );
  const seen = burst.map((r) => JSON.parse(r.stdout));
  assert.deepEqual(
    seen.map((s) => [s.seen, s.env]),
    Array.from({ length: 8 }, (_, i) => ['none', `w${i}`])
  );
  assert.equal(new Set(seen.map((s) => s.pid)).size, 8);
  for (const bad of [-1, 1.5, 65, '2']) {
    await assert.rejects(
      createNodeKernel({ warmWorkers: bad }),
      /warmWorkers must be an integer from 0 to 64/
    );
  }
  const none = await createNodeKernel({ users: 'off', warmWorker: false, warmWorkers: 4 });
  t.after(() => none.terminate());
  await none.writeFile('/node_modules/warm/package.json', PACKAGE);
  await none.writeFile('/node_modules/warm/main.mjs', PROGRAM);
  assert.equal((await none.run(['warm', 'x'], { cwd: '/' })).status, 0);
});
