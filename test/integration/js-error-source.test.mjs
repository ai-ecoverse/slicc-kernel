import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const KERNEL_URL = new URL('../../dist/node-process-worker.js', import.meta.url).href;

async function run(t, source) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/es/package.json',
    JSON.stringify({ name: 'es', slicc: { commands: { es: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/es/main.mjs', source);
  const r = await kernel.run(['es'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const BODY = `
const grab = (f) => { try { f(); } catch (e) { return e; } };
const plain = (v) => (v === undefined ? 'undefined' : { ...v, proto: Object.getPrototypeOf(v), frozen: Object.isFrozen(v) });
async function body(ctx) {
  const s = 'null.d';
  const r = {};
  r.type = typeof ctx.sync.errorSource;
  r.eval = plain(ctx.sync.errorSource(grab(() => eval(s))));
  r.nested = plain(ctx.sync.errorSource(grab(() => eval('eval(s)'))));
  const o = {};
  for (const [k, src] of Object.entries({ undefinedFn: 'undefinedFn()', notFn: 'o.f()', ref: 'zzz', tdz: '{ x; let x = 1; }', made: 'throw new Error("m")' })) {
    r[k] = plain(ctx.sync.errorSource(grab(() => eval(src))));
  }
  const late = grab(() => eval('o.g()'));
  void late.stack;
  r.afterStack = plain(ctx.sync.errorSource(late));
  r.script = plain(ctx.sync.errorSource(grab(() => ctx.sync.runScript('\\n\\nundefined.q', { filename: 's.js' }))));
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
}`;

test("ctx.sync.errorSource gives the source line of an error in the program's own eval'd code or runScript script, as Node prints it, in a process and a thread, also for a call of a non-function, a ReferenceError, a TDZ error and a thrown Error, and after .stack was read (#1610, #1633)", async (t) => {
  const one = {
    type: 'function',
    eval: { sourceLine: 'null.d', lineNumber: 1, startColumn: 5, proto: null, frozen: true },
    nested: { sourceLine: 'null.d', lineNumber: 1, startColumn: 5, proto: null, frozen: true },
    undefinedFn: {
      sourceLine: 'undefinedFn()',
      lineNumber: 1,
      startColumn: 0,
      proto: null,
      frozen: true,
    },
    notFn: { sourceLine: 'o.f()', lineNumber: 1, startColumn: 2, proto: null, frozen: true },
    ref: { sourceLine: 'zzz', lineNumber: 1, startColumn: 0, proto: null, frozen: true },
    tdz: {
      sourceLine: '{ x; let x = 1; }',
      lineNumber: 1,
      startColumn: 2,
      proto: null,
      frozen: true,
    },
    made: {
      sourceLine: 'throw new Error("m")',
      lineNumber: 1,
      startColumn: 6,
      proto: null,
      frozen: true,
    },
    afterStack: { sourceLine: 'o.g()', lineNumber: 1, startColumn: 2, proto: null, frozen: true },
    script: {
      sourceLine: 'undefined.q',
      lineNumber: 3,
      startColumn: 10,
      proto: null,
      frozen: true,
    },
  };
  const [proc, thread] = await run(t, BODY);
  assert.deepEqual(proc, one);
  assert.deepEqual(thread, one);
});

test("errorSource answers undefined for kernel-made errors, non-errors, a script named like the kernel worker at the kernel's own line, and errors an own Error.prepareStackTrace formats (#1610)", async (t) => {
  const bundle = await readFile(new URL(KERNEL_URL), 'utf8');
  const line = bundle.split('\n').findIndex((l) => /return positions\d*\(error\)/.test(l)) + 1;
  assert.ok(line > 0, 'the kernel line that asks V8 for the positions');
  const out = await run(
    t,
    `export default async function main(ctx) {
  const grab = (f) => { try { f(); } catch (e) { return e; } };
  const q = (v) => ctx.sync.errorSource(v) ?? null;
  const r = {};
  r.kernel = q(grab(() => ctx.sync.open('/nope/x')));
  r.kernelAsync = q(await ctx.fs.readFile('/nope/y').catch((e) => e));
  r.values = [q({}), q(1), q(null), q(undefined), q('x'), q(Object.create(Error.prototype)), q(new Proxy(new Error('p'), {}))];
  r.borrowed = [];
  for (const name of ['slicc-kernel:/node-process-worker.js', ${JSON.stringify(KERNEL_URL)}]) {
    const src = '\\n'.repeat(${line} - 1) + 'throw new Error("q")';
    const got = q(grab(() => ctx.sync.runScript(src, { filename: name })));
    if (got) r.borrowed.push(name + ': ' + got.sourceLine);
  }
  Error.prepareStackTrace = (e, sites) => 'OWN';
  r.own = q(grab(() => eval('null.x')));
  delete Error.prepareStackTrace;
  await ctx.write(1, JSON.stringify(r));
  return 0;
}`
  );
  assert.deepEqual(out, {
    kernel: null,
    kernelAsync: null,
    values: [null, null, null, null, null, null, null],
    borrowed: [],
    own: null,
  });
});

test('reaching the source positions at start-up prints no warning on the host (#1610)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-eshost-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'host.mjs');
  await writeFile(
    file,
    `const { createNodeKernel } = await import(process.env.DIST_URL);
const k = await createNodeKernel({ users: 'off' });
await k.writeFile('/node_modules/es/package.json', JSON.stringify({ name: 'es', slicc: { commands: { es: { abi: 'js', module: 'main.mjs' } } } }));
await k.writeFile('/node_modules/es/main.mjs', 'export default async (ctx) => { await ctx.write(1, typeof ctx.sync.errorSource); return 0; };');
const r = await k.run(['es'], { cwd: '/' });
k.terminate();
console.log(r.status + ' ' + r.stdout);
`
  );
  const r = spawnSync(process.execPath, [file], {
    env: { ...process.env, DIST_URL: new URL('../../dist/node.js', import.meta.url).href },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '0 function\n');
  assert.equal(r.stderr, '');
});

test("a program's new Function or eval code named by //# sourceURL keeps its frames for the formatter, and errorSource answers for it by that name; a sourceURL naming the kernel worker shows only the program's own frame and errorSource refuses it (#1632)", async (t) => {
  const out = await run(
    t,
    `export default async function main(ctx) {
  const grab = (f) => { try { f(); } catch (e) { return e; } };
  const o = {};
  const seen = [];
  ctx.sync.setStackFormatter((e, sites) => {
    seen.push(sites.map((s) => [s.getScriptNameOrSourceURL() ?? null, s.getLineNumber(), s.isEval()]));
    return 'FMT';
  });
  const q = (e) => { void e.stack; return ctx.sync.errorSource(e) ?? null; };
  const r = {};
  r.fn = q(grab(() => new Function('o', '\\n\\no.f()\\n//# sourceURL=/os/a.js')(o)));
  r.ev = q(grab(() => eval('o.f()\\n//# sourceURL=/os/b.js')));
  r.spoof = q(grab(() => new Function('o', 'o.f()\\n//# sourceURL=slicc-kernel:/node-process-worker.js')(o)));
  r.spoofUrl = q(grab(() => new Function('o', 'o.f()\\n//# sourceURL=' + ${JSON.stringify(KERNEL_URL)})(o)));
  r.top = seen.map((frames) => frames[0]);
  r.kernelLines = seen.flat().filter(([name, line]) => /node-process-worker/.test(name ?? '') && line > 10).length;
  r.names = [...new Set(seen.flat().map(([name]) => (name ?? '').split(':')[0]))].sort();
  await ctx.write(1, JSON.stringify(r));
  return 0;
}`
  );
  assert.deepEqual(out, {
    fn: { sourceLine: 'o.f()', lineNumber: 5, startColumn: 2 },
    ev: { sourceLine: 'o.f()', lineNumber: 1, startColumn: 2 },
    spoof: null,
    spoofUrl: null,
    top: [
      ['/os/a.js', 5, true],
      ['/os/b.js', 1, true],
      ['slicc-kernel:/node-process-worker.js', 3, true],
      [KERNEL_URL, 3, true],
    ],
    kernelLines: 0,
    names: ['/os/a.js', '/os/b.js', 'file', 'slicc-kernel', 'slicc-module'].sort(),
  });
});
