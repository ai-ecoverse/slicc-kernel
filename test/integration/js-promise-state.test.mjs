import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const PROBE = `const probe = async (ctx) => {
  const ps = (p) => ctx.sync.promiseState(p);
  const out = {};
  const reason = { why: 'no' };
  const rejected = Promise.reject(reason);
  rejected.catch(() => {});
  const pending = new Promise(() => {});
  out.basic = [ps(Promise.resolve(1)), ps(pending), ps(rejected).state, ps(rejected).value === reason];
  out.primitives = [ps(Promise.resolve(10n)).value === 10n, Number.isNaN(ps(Promise.resolve(NaN)).value), Object.is(ps(Promise.resolve(-0)).value, -0), ps(Promise.resolve(Infinity)).value, ps(Promise.resolve(undefined)).value === undefined, typeof ps(Promise.resolve(Symbol.iterator)).value];
  const kinds = [];
  for (const bad of [1, { then() {} }, new Proxy(Promise.resolve(1), {})]) {
    try {
      ps(bad);
      kinds.push('ran');
    } catch (err) {
      kinds.push(err.constructor.name);
    }
  }
  out.refused = kinds;
  out.keys = Object.getOwnPropertyNames(globalThis).filter((k) => k.startsWith('__slicc_promise_'));
  return { out, rejected };
};
`;

const MAIN = `${PROBE}
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    const { out } = await probe(ctx);
    ctx.thread.port.postMessage(out);
    await new Promise(() => {});
  }
  if (ctx.argv[1] === 'thread') {
    const t = await ctx.thread.spawn({});
    const got = await new Promise((resolve) => {
      t.port.onmessage = (e) => resolve(e.data);
    });
    await t.terminate();
    await ctx.write(1, JSON.stringify(got));
    return 0;
  }
  const { out } = await probe(ctx);
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

const WANT = {
  basic: [{ state: 'fulfilled', value: 1 }, { state: 'pending' }, 'rejected', true],
  primitives: [true, true, true, null, true, 'symbol'],
  refused: ['TypeError', 'TypeError', 'TypeError'],
  keys: [],
};

async function program(kernel, name, source) {
  await kernel.writeFile(
    `/node_modules/${name}/package.json`,
    JSON.stringify({ name, slicc: { commands: { [name]: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile(`/node_modules/${name}/main.mjs`, source);
}

for (const where of ['process', 'thread']) {
  test(`ctx.sync.promiseState gives a native promise's state and its very value on Node, in a ${where}, refuses anything else, and leaves nothing on the global (#1531)`, async (t) => {
    const kernel = await createNodeKernel({ users: 'off' });
    t.after(() => kernel.terminate());
    await program(kernel, 'ps', MAIN);
    const r = await kernel.run(['ps', where], { cwd: '/' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), WANT);
  });
}

const HOSTILE = `export default async function main(ctx) {
  const calls = [];
  const define = Object.defineProperty;
  const describe = Object.getOwnPropertyDescriptor;
  const proto = Object.prototype;
  const trap = (name) =>
    new Proxy(function () {}, {
      get(_t, k) {
        calls.push(name + '.get.' + String(k));
        return undefined;
      },
      apply() {
        calls.push(name + '.apply');
      },
      construct() {
        calls.push(name + '.construct');
        return {};
      },
      has() {
        calls.push(name + '.has');
        return false;
      },
    });
  const value = {};
  let read = 0;
  define(value, 'peek', { get() { read++; return 1; }, enumerable: true });
  class Fancy extends Promise {
    get then() {
      read++;
      return super.then;
    }
  }
  const fancy = Fancy.resolve(value);
  define(fancy, 'own', { get() { read++; return 2; }, enumerable: true });
  const reason = { r: 1 };
  const rejected = Promise.reject(reason);
  rejected.catch(() => {});
  const pending = new Promise(() => {});
  const seven = Promise.resolve(7);
  globalThis.trapFor = trap;
  ctx.sync.runScript('let globalThis = trapFor("globalThis"); let Object = trapFor("Object"); let Reflect = trapFor("Reflect");', { filename: 'shadow.js' });
  const ps = ctx.sync.promiseState;
  const got = [ps(fancy).value === value, ps(rejected).value === reason, ps(rejected).state, ps(pending).state, ps(seven).value];
  const polluted = [];
  for (const [where, k, d] of [
    [proto, 'v', { set() { calls.push('proto.v'); }, configurable: true }],
    [proto, 'objectId', { get() { calls.push('proto.objectId'); return 'x'; }, configurable: true }],
    [proto, 'error', { get() { calls.push('proto.error'); return undefined; }, configurable: true }],
    [proto, 'toJSON', { value() { calls.push('proto.toJSON'); return {}; }, configurable: true }],
    [Array.prototype, 'toJSON', { value() { calls.push('array.toJSON'); return []; }, configurable: true }],
    [String.prototype, 'toJSON', { value() { calls.push('string.toJSON'); return ''; }, configurable: true }],
  ]) {
    define(where, k, d);
    polluted.push(ps(seven));
    delete where[k];
  }
  const swapped = [];
  const keep = describe(proto, 'toLocaleString');
  const protoKey = describe(proto, '__proto__');
  for (const swap of [
    () => {
      delete proto.toLocaleString;
      define(proto, 'toJSON', { value() { calls.push('swap.toJSON'); return {}; }, configurable: true, writable: true });
    },
    () => define(proto, '__proto__', { get() { calls.push('swap.__proto__'); return null; }, set() { calls.push('swap.__proto__.set'); }, configurable: true }),
    () => {
      delete proto.toLocaleString;
      define(proto, 'params', { set() { calls.push('swap.params'); }, configurable: true });
    },
  ]) {
    swap();
    try {
      swapped.push(ps(seven));
    } catch (err) {
      swapped.push('threw ' + err.message);
    }
    delete proto.toJSON;
    delete proto.params;
    define(proto, '__proto__', protoKey);
    define(proto, 'toLocaleString', keep);
  }
  got.push(polluted, swapped, ps(seven).value);
  await ctx.write(1, JSON.stringify({ got, read, calls }));
  return 0;
}
`;

test('ctx.sync.promiseState runs no program code: global let shadows of globalThis, Object and Reflect, getters on the value and on a promise subclass never run, and with Object.prototype changed in any way (added, replaced or swapped keys) or a toJSON on a prototype it answers undefined rather than run any of it (#1531)', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await program(kernel, 'hostile', HOSTILE);
  const r = await kernel.run(['hostile'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    got: [
      true,
      true,
      'rejected',
      'pending',
      7,
      [null, null, null, null, null, null],
      [null, null, null],
      7,
    ],
    read: 0,
    calls: [],
  });
});

test('ctx.sync.promiseState is undefined in a page (#1531)', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page } = await bootedPage(chrome, t);
  const r = await page.evaluate(async () => {
    const main = `export default async (ctx) => {
      await ctx.write(1, JSON.stringify([typeof ctx.sync.promiseState, ctx.sync.promiseState(Promise.resolve(1)) === undefined]));
      return 0;
    };`;
    await window.opfs.write(
      'node_modules/ps/package.json',
      JSON.stringify({ name: 'ps', slicc: { commands: { ps: { abi: 'js', module: 'main.mjs' } } } })
    );
    await window.opfs.write('node_modules/ps/main.mjs', main);
    return window.kernel.run(['ps'], { cwd: '/' });
  });
  assert.deepEqual([r.status, JSON.parse(r.stdout), r.stderr], [0, ['function', true], '']);
});
