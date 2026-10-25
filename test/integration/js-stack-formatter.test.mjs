import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

async function run(t, source) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/sf/package.json',
    JSON.stringify({ name: 'sf', slicc: { commands: { sf: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/sf/main.mjs', source);
  const r = await kernel.run(['sf'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const FRAMES = `
const frames = (sites) => sites.map((s) => ({
  file: s.getFileName() ?? null,
  text: String(s),
  fn: typeof s.getFunction(),
  self: typeof s.getThis(),
}));
`;

test('ctx.sync.setStackFormatter formats .stack when no own Error.prepareStackTrace is set, and Error.prepareStackTrace stays a plain property as in Node (#1612)', async (t) => {
  const out = await run(
    t,
    `${FRAMES}
export default async function main(ctx) {
  'use strict';
  const r = {};
  r.type = typeof ctx.sync.setStackFormatter;
  r.first = ctx.sync.setStackFormatter((e, sites) => 'FMT ' + e.message + ' ' + sites.length);
  r.stack = new Error('a').stack;
  r.own = (() => { Error.prepareStackTrace = () => 'OWN'; const s = new Error('b').stack; delete Error.prepareStackTrace; return s; })();
  r.after = new Error('c').stack.startsWith('FMT c');
  r.deleted = typeof Error.prepareStackTrace;
  r.proto = Object.getPrototypeOf(Error) === Function.prototype;
  r.has = Object.prototype.hasOwnProperty.call(Error, 'prepareStackTrace');
  class Frozen extends Error {}
  Object.freeze(Frozen);
  try { Frozen.prepareStackTrace = () => 'x'; r.frozen = 'assigned'; } catch (e) { r.frozen = e.name; }
  r.previous = typeof ctx.sync.setStackFormatter(null);
  r.plain = new Error('d').stack.split('\\n')[0];
  try { ctx.sync.setStackFormatter('nope'); } catch (e) { r.bad = e.name; }
  await ctx.write(1, JSON.stringify(r));
  return 0;
}`
  );
  assert.deepEqual(out, {
    type: 'function',
    first: null,
    stack: 'FMT a 1',
    own: 'OWN',
    after: true,
    deleted: 'undefined',
    proto: true,
    has: false,
    frozen: 'TypeError',
    previous: 'function',
    plain: 'Error: d',
    bad: 'TypeError',
  });
});

test("the formatter gets a fresh array of only the program's own and node: frames, all strict (no function or receiver), never a kernel frame or a host path, even when a kernel error is formatted or a script borrows the kernel worker's file name (#1612)", async (t) => {
  const kernelFile = new URL('../../dist/node-process-worker.js', import.meta.url).href;
  const all = await run(
    t,
    `${FRAMES}
async function body(ctx) {
  'use strict';
  const seen = [];
  let last;
  ctx.sync.setStackFormatter((e, sites) => {
    seen.push(...frames(sites));
    const fresh = sites !== last;
    last = sites;
    sites.length = 0;
    return 'FMT ' + fresh;
  });
  const r = {};
  r.own = new Error('own').stack;
  try { ctx.sync.open('/nope/x'); } catch (e) { r.kernel = e.stack; }
  try { await ctx.fs.readFile('/nope/y'); } catch (e) { r.async = e.stack; }
  r.spoof = ctx.sync.runScript('"use strict"; new Error("spoof").stack', { filename: ${JSON.stringify(kernelFile)} }).value;
  r.mapped = [1].map(() => new Error('m').stack)[0];
  r.eval = eval('new Error("e").stack');
  r.seen = seen;
  return r;
}
export default async function main(ctx) {
  const r = await body(ctx);
  if (ctx.thread.tid !== 0) {
    ctx.thread.port.postMessage(r);
    await new Promise(() => {});
  }
  const t = await ctx.thread.spawn({});
  const inThread = await new Promise((resolve) => { t.port.onmessage = (e) => resolve(e.data); });
  await t.terminate();
  await ctx.write(1, JSON.stringify([r, inThread]));
  return 0;
}`
  );
  for (const [thread, out] of all.entries()) {
    for (const key of ['own', 'kernel', 'async', 'spoof', 'mapped', 'eval'])
      assert.equal(out[key], 'FMT true', `${key} (thread: ${thread})`);
    assert.ok(out.seen.length > 0);
    for (const frame of out.seen) {
      assert.equal(frame.fn, 'undefined', JSON.stringify(frame));
      assert.equal(frame.self, 'undefined', JSON.stringify(frame));
      if (frame.file !== kernelFile) {
        assert.ok(
          !frame.text.includes(DIST) && !frame.text.includes('file:'),
          JSON.stringify(frame)
        );
      }
      if (frame.file !== null) {
        assert.ok(
          frame.file.startsWith('slicc-module:') ||
            frame.file.startsWith('node:') ||
            frame.file === kernelFile,
          JSON.stringify(frame)
        );
      }
    }
    assert.equal(
      out.seen.filter((f) => f.file === kernelFile).length,
      1,
      'only the borrowed-name script frame itself'
    );
  }
});

test('a formatter that throws, returns a non-string or nests falls back to the default stack; one that calls ctx.sync while a kernel-made error is formatted neither deadlocks nor breaks the lane (#1612)', async (t) => {
  const out = await run(
    t,
    `export default async function main(ctx) {
  const r = {};
  ctx.sync.setStackFormatter(() => { throw new Error('inner'); });
  r.throws = new Error('t').stack.split('\\n')[0];
  ctx.sync.setStackFormatter(() => 42);
  r.number = new Error('n').stack.split('\\n')[0];
  ctx.sync.setStackFormatter((e) => 'outer ' + new Error('nested').stack.split('\\n')[0] + ' / ' + e.message);
  r.nested = new Error('x').stack;
  let calls = 0;
  ctx.sync.setStackFormatter((e) => { calls++; ctx.sync.cred(); return 'umask ' + typeof ctx.sync.umask() + ' ' + e.message; });
  try { ctx.sync.open('/nope/z'); } catch (e) { r.kernel = e.stack; }
  r.lane = ctx.sync.umask() === ctx.sync.umask();
  r.calls = calls;
  ctx.sync.setStackFormatter(null);
  await ctx.write(1, JSON.stringify(r));
  return 0;
}`
  );
  assert.equal(out.throws, 'Error: t');
  assert.equal(out.number, 'Error: n');
  assert.equal(out.nested, 'outer Error: nested / x');
  assert.match(out.kernel, /^umask number \/nope\/z: ENOENT/);
  assert.equal(out.lane, true);
  assert.equal(out.calls, 1);
});

test('the exposed internals stay out of reach: internal/* and node:internal/* by import, import() of a built string, import.meta.resolve, a data: module, node:module and node:worker_threads are refused, and there is no require, process or Worker (#1612)', async (t) => {
  const out = await run(
    t,
    `export default async function main(ctx) {
  const tryImport = (s) => import(s).then(() => 'reached', (e) => e.code);
  const tryResolve = (s) => { try { return import.meta.resolve(s); } catch (e) { return e.code; } };
  const built = ['inter', 'nal/test/binding'].join('');
  const r = {
    internal: await tryImport('internal/errors'),
    nodeInternal: await tryImport('node:internal/errors'),
    built: await tryImport(built),
    resolve: tryResolve('internal/errors'),
    resolveNode: tryResolve('node:internal/errors'),
    data: await tryImport('data:text/javascript,export default 1; import "internal/errors";'),
    module: await tryImport('node:module'),
    workers: await tryImport('node:worker_threads'),
    globals: [typeof globalThis.require, typeof globalThis.process, typeof globalThis.Worker, typeof Function('return this')().process],
  };
  await ctx.write(1, JSON.stringify(r));
  return 0;
}`
  );
  assert.deepEqual(out, {
    internal: 'ERR_ACCESS_DENIED',
    nodeInternal: 'ERR_ACCESS_DENIED',
    built: 'ERR_ACCESS_DENIED',
    resolve: 'ERR_ACCESS_DENIED',
    resolveNode: 'ERR_ACCESS_DENIED',
    data: 'ERR_ACCESS_DENIED',
    module: 'ERR_ACCESS_DENIED',
    workers: 'ERR_ACCESS_DENIED',
    globals: ['undefined', 'undefined', 'undefined', 'undefined'],
  });
  assert.throws(() => createRequire(import.meta.url)('internal/errors'), {
    code: 'MODULE_NOT_FOUND',
  });
});

const HOST = `
const { createNodeKernel } = await import(process.env.DIST_URL);
const k = await createNodeKernel({ users: 'off' });
await k.writeFile('/node_modules/sf/package.json', JSON.stringify({ name: 'sf', slicc: { commands: { sf: { abi: 'js', module: 'main.mjs' } } } }));
await k.writeFile('/node_modules/sf/main.mjs', 'export default async (ctx) => { await ctx.write(1, typeof ctx.sync.setStackFormatter); return 0; };');
const r = await k.run(['sf'], { cwd: '/' });
k.terminate();
console.log(r.status + ' ' + r.stdout);
`;

test('a host started with a flag workers refuse (--expose-gc) still runs programs with the formatter; the host itself keeps no internals (#1612)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-sfhost-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'host.mjs');
  await writeFile(
    file,
    `${HOST}\ntry { (await import('node:module')).createRequire(import.meta.url)('internal/errors'); console.log('host reached'); } catch (e) { console.log('host ' + e.code); }\n`
  );
  const r = spawnSync(process.execPath, ['--expose-gc', file], {
    env: { ...process.env, DIST_URL: new URL('../../dist/node.js', import.meta.url).href },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '0 function\nhost MODULE_NOT_FOUND\n');
});
