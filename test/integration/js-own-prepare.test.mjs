import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    '/node_modules/op/package.json',
    JSON.stringify({ name: 'op', slicc: { commands: { op: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/op/main.mjs', source);
  const r = await kernel.run(['op'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("a program's own Error.prepareStackTrace gets only the program's own, node: and native CallSites, all strict, never a kernel frame or host path, with Error as receiver; its result and throws are the stack as in Node (#1631)", async (t) => {
  const out = await run(
    t,
    `export default async function main(ctx) {
  'use strict';
  const r = {};
  const grab = (f) => { try { f(); } catch (e) { return e; } };
  const frames = [];
  Error.prepareStackTrace = function (e, sites) {
    r.self = this === Error;
    for (const s of sites) frames.push({ text: String(s), file: s.getFileName() ?? null, fn: typeof s.getFunction(), self: typeof s.getThis() });
    return sites;
  };
  r.isArray = Array.isArray(new Error('own').stack);
  r.kernel = Array.isArray(grab(() => ctx.sync.open('/nope/x')).stack);
  r.async = Array.isArray((await ctx.fs.readFile('/nope/y').catch((e) => e)).stack);
  r.mapped = [1].map(() => Array.isArray(new Error('m').stack))[0];
  Error.prepareStackTrace = () => { throw new Error('thrown'); };
  try { void new Error('t').stack; r.throws = 'no'; } catch (e) { r.throws = e.message; }
  Error.prepareStackTrace = () => 'outer ' + new Error('inner').stack.split('\\n')[0];
  r.nested = new Error('n').stack;
  Error.prepareStackTrace = 42;
  r.nonFunction = new Error('x').stack.split('\\n')[0];
  delete Error.prepareStackTrace;
  r.deleted = typeof Error.prepareStackTrace;
  r.proto = Object.getPrototypeOf(Error) === Function.prototype;
  r.frames = frames;
  await ctx.write(1, JSON.stringify(r));
  return 0;
}`
  );
  const { frames, ...rest } = out;
  assert.deepEqual(rest, {
    self: true,
    isArray: true,
    kernel: true,
    async: true,
    mapped: true,
    throws: 'thrown',
    nested: 'outer Error: inner',
    nonFunction: 'Error: x',
    deleted: 'undefined',
    proto: true,
  });
  assert.ok(frames.length >= 5);
  for (const f of frames) {
    assert.equal(f.fn, 'undefined', JSON.stringify(f));
    assert.equal(f.self, 'undefined', JSON.stringify(f));
    assert.ok(!f.text.includes(DIST) && !f.text.includes('node-process-worker'), JSON.stringify(f));
    assert.ok(
      f.file === null || f.file.startsWith('slicc-module:') || f.file.startsWith('node:'),
      JSON.stringify(f)
    );
  }
});

test("setStackFormatter(fn, { own: true }) runs fn for every stack with the program's own Error.prepareStackTrace (or undefined, never Node's default or a kernel function), and fn's result or throw is the stack as it stands; errorSource still answers (#1631)", async (t) => {
  const out = await run(
    t,
    `export default async function main(ctx) {
  'use strict';
  const r = {};
  const grab = (f) => { try { f(); } catch (e) { return e; } };
  const owns = [];
  const prog = (e, sites) => 'PROG ' + sites.length;
  ctx.sync.setStackFormatter((e, sites, own) => {
    owns.push(own === undefined ? 'undefined' : own === prog ? 'prog' : 'other');
    if (e.message === 'array') return sites;
    if (e.message === 'throw') throw new Error('fmt threw');
    return own ? own(e, sites) : 'FMT ' + sites.length;
  }, { own: true });
  r.none = new Error('a').stack;
  Error.prepareStackTrace = prog;
  r.own = new Error('b').stack;
  delete Error.prepareStackTrace;
  r.deleted = new Error('c').stack;
  r.array = Array.isArray(new Error('array').stack);
  try { void new Error('throw').stack; r.threw = 'no'; } catch (e) { r.threw = e.message; }
  const o = {};
  r.source = ctx.sync.errorSource(grab(() => eval('o.f()'))) ?? null;
  try { ctx.sync.setStackFormatter(() => '', { own: 'yes' }); } catch (e) { r.badOption = e.name; }
  ctx.sync.setStackFormatter(null);
  r.after = new Error('z').stack.split('\\n')[0];
  r.owns = owns;
  await ctx.write(1, JSON.stringify(r));
  return 0;
}`
  );
  assert.deepEqual(out, {
    none: 'FMT 1',
    own: 'PROG 1',
    deleted: 'FMT 1',
    array: true,
    threw: 'fmt threw',
    source: { sourceLine: 'o.f()', lineNumber: 1, startColumn: 2 },
    badOption: 'TypeError',
    after: 'Error: z',
    owns: ['undefined', 'prog', 'undefined', 'undefined', 'undefined', 'undefined'],
  });
});

test("the realm's Error is read as Node 26 reads it: a replaced global Error's prepareStackTrace getter runs with that Error as receiver, twice per format (#1631)", async (t) => {
  const out = await run(
    t,
    `export default async function main(ctx) {
  const Real = Error;
  let reads = 0;
  let self;
  const Fake = function () {};
  Object.defineProperty(Fake, 'prepareStackTrace', { get() { reads++; self = this; return (e, s) => 'FAKE ' + s.length; }, configurable: true });
  globalThis.Error = Fake;
  const stack = new Real('x').stack;
  globalThis.Error = Real;
  await ctx.write(1, JSON.stringify({ stack, reads, self: self === Fake }));
  return 0;
}`
  );
  assert.deepEqual(out, { stack: 'FAKE 1', reads: 2, self: true });
});

const enc = new TextEncoder();
const str = (x) => [enc.encode(x).length, ...enc.encode(x)];
const section = (id, body) => [id, body.length, ...body];
const TRAP = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  ...section(1, [1, 0x60, 0, 0]),
  ...section(3, [2, 0, 0]),
  ...section(5, [1, 0, 1]),
  ...section(7, [2, ...str('memory'), 2, 0, ...str('_start'), 0, 0]),
  ...section(10, [2, 4, 0, 0x10, 1, 0x0b, 3, 0, 0x00, 0x0b]),
]);

test("with a host preload that sets its own Error.prepareStackTrace, the kernel's own diagnostics keep their raw frames (a wasm trap's backtrace), while a program's .stack through that function sees no kernel frame (#1631)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-ownhost-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, 'pre.mjs'),
    "Error.prepareStackTrace = (e, sites) => `${e.name}: ${e.message}` + sites.map((s) => `\\n    at ${s}`).join('');\n"
  );
  await writeFile(
    join(dir, 'host.mjs'),
    `const { createNodeKernel } = await import(process.env.DIST_URL);
const k = await createNodeKernel({ users: 'off' });
await k.writeFile('/home/trap.wasm', new Uint8Array(${JSON.stringify([...TRAP])}), { mode: 0o755 });
const trap = await k.run(['/home/trap.wasm'], { cwd: '/', env: { SLICC_WASM_BACKTRACE: '1' } });
await k.writeFile('/node_modules/op/package.json', JSON.stringify({ name: 'op', slicc: { commands: { op: { abi: 'js', module: 'main.mjs' } } } }));
await k.writeFile('/node_modules/op/main.mjs', "export default async (ctx) => { let s; try { ctx.sync.open('/nope'); } catch (e) { s = e.stack; } await ctx.write(1, s); return 0; };");
const js = await k.run(['op'], { cwd: '/' });
k.terminate();
console.log(JSON.stringify({ trap: trap.stderr, js: js.stdout }));
`
  );
  const r = spawnSync(process.execPath, ['--import', join(dir, 'pre.mjs'), join(dir, 'host.mjs')], {
    env: { ...process.env, DIST_URL: new URL('../../dist/node.js', import.meta.url).href },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const { trap, js } = JSON.parse(r.stdout);
  assert.match(trap, /wasm trap: unreachable\n\s+at .*wasm:\/\/wasm\//);
  assert.match(js, /^\w*Error: \/nope: ENOENT\n\s+at /);
  assert.doesNotMatch(js, /node-process-worker|slicc-kernel:|file:/);
});

const NODE_ORDER = `
const vm = require('node:vm');
const out = {};
out.defaultName = typeof Error.prepareStackTrace === 'function' ? Error.prepareStackTrace.name : typeof Error.prepareStackTrace;
let self;
Error.prepareStackTrace = function (e, s) { self = this; return 'OWN'; };
out.own = new Error('x').stack;
out.receiver = self === Error;
out.otherRealm = vm.runInNewContext('delete Error.prepareStackTrace; new Error("y").stack');
let reads = 0;
const Real = Error;
const Fake = function () {};
Object.defineProperty(Fake, 'prepareStackTrace', { get() { reads++; return () => 'FAKE'; } });
globalThis.Error = Fake;
out.fake = new Real('z').stack;
globalThis.Error = Real;
out.reads = reads;
delete Error.prepareStackTrace;
out.deleted = new Error('d').stack.split('\\n')[0];
try {
  const e = require('internal/errors');
  out.source = require('node:crypto').createHash('sha256').update(String(e.prepareStackTraceCallback)).digest('hex');
} catch (err) {
  out.source = err.code;
}
console.log(JSON.stringify(out));
`;

test("Node's own stack callback order is what the kernel's copy mirrors (a pin: if this fails after a Node upgrade, re-check src/node-stack.ts kernelCallback against Node's prepareStackTraceCallback) (#1631)", () => {
  const r = spawnSync(process.execPath, ['--expose-internals', '--no-warnings', '-e', NODE_ORDER], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    defaultName: 'ErrorPrepareStackTrace',
    own: 'OWN',
    receiver: true,
    otherRealm: 'OWN',
    fake: 'FAKE',
    reads: 2,
    deleted: 'Error: d',
    source: 'fd0404511268d9be1fca3236d6759d5026e23d6921a25766917b6ead3ca111f9',
  });
});
