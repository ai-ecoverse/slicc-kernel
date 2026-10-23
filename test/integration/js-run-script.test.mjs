import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { launch } from './chrome.mjs';
import { booted as bootedPage } from './kernel.mjs';

const PROGRAM = `const probe = async (ctx) => {
  const run = (source, options) => ctx.sync.runScript(source, options);
  const out = {};
  out.strictVar = [run('"use strict"; var rsStrict = 1; rsStrict').value, globalThis.rsStrict];
  run('let rsLet = 2; const rsConst = 3; class RsClass {}');
  out.lexical = [(0, eval)('typeof rsLet'), (0, eval)('rsConst'), (0, eval)('typeof RsClass'), 'rsLet' in globalThis];
  out.completion = run('1 + 2', { filename: 'calc.js' });
  try {
    run('throw new Error("boom")', { filename: 'named-file.js' });
  } catch (err) {
    out.thrown = [err instanceof Error, err.message, /named-file\\.js/.test(err.stack)];
  }
  out.importNode = await run('import("node:fs")').value.then(() => 'loaded', (err) => 'rejected ' + (err?.code ?? err?.name));
  out.importRelative = await run('import("./x.mjs")').value.then(() => 'loaded', (err) => 'rejected ' + (err?.code ?? err?.name));
  out.same = run('[typeof require, typeof module, typeof process, typeof process?.binding].join()').value === [typeof require, typeof module, typeof process, typeof globalThis.process?.binding].join();
  const types = [];
  for (const args of [[1], [{}], ['1', { filename: 2 }]]) {
    try {
      run(...args);
      types.push('ran');
    } catch (err) {
      types.push(err.constructor.name);
    }
  }
  out.types = types;
  const frozen = [];
  for (const name of ['XMLHttpRequest', 'indexedDB', 'close', 'localStorage', 'NaN']) {
    const before = globalThis[name];
    for (const src of ['var ' + name + ' = 7;', 'function ' + name + '() { return 7; }', 'let ' + name + ' = 7;']) {
      try {
        run(src);
      } catch {}
    }
    frozen.push(Object.is(globalThis[name], before));
  }
  out.frozen = frozen;
  return out;
};
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    ctx.thread.port.postMessage(await probe(ctx));
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
  await ctx.write(1, JSON.stringify(await probe(ctx)));
  return 0;
}
`;

const WANT = {
  strictVar: [1, 1],
  lexical: ['number', 3, 'function', false],
  completion: { value: 3, completion: true },
  thrown: [true, 'boom', true],
  importNode: 'rejected ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
  importRelative: 'rejected ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
  same: true,
  types: ['TypeError', 'TypeError', 'TypeError'],
  frozen: [true, true, true, true, true],
};

async function install(kernel) {
  await kernel.writeFile(
    '/node_modules/rs/package.json',
    JSON.stringify({ name: 'rs', slicc: { commands: { rs: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/rs/main.mjs', PROGRAM);
}

for (const where of ['process', 'thread']) {
  test(`ctx.sync.runScript runs a classic script in the program's global scope on Node, in a ${where}: strict var on the global, let/const/class in the global lexical scope, the completion value, a named stack; import() is refused, it sees what the program sees, bad arguments are TypeErrors, and no declaration replaces a global the program can't assign (#1541)`, async (t) => {
    const kernel = await createNodeKernel({ users: 'off' });
    t.after(() => kernel.terminate());
    await install(kernel);
    const r = await kernel.run(['rs', where], { cwd: '/' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), WANT);
  });
}

test('ctx.sync.runScript is undefined in a page, where process workers are module workers, and still refuses a non-string (#1541)', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const { page } = await bootedPage(chrome, t);
  const r = await page.evaluate(async () => {
    const main = `export default async (ctx) => {
      let bad;
      try { ctx.sync.runScript(1); bad = 'ran'; } catch (err) { bad = err.constructor.name; }
      await ctx.write(1, JSON.stringify([typeof ctx.sync.runScript, ctx.sync.runScript('1') === undefined, bad]));
      return 0;
    };`;
    await window.opfs.write(
      'node_modules/rs/package.json',
      JSON.stringify({ name: 'rs', slicc: { commands: { rs: { abi: 'js', module: 'main.mjs' } } } })
    );
    await window.opfs.write('node_modules/rs/main.mjs', main);
    return window.kernel.run(['rs'], { cwd: '/' });
  });
  assert.deepEqual(
    [r.status, JSON.parse(r.stdout), r.stderr],
    [0, ['function', true, 'TypeError'], '']
  );
});

const POLLUTER = `export default async (ctx) => {
  let spied = 0;
  Object.prototype.timeout = 1;
  Object.prototype.importModuleDynamically = () => {
    spied++;
    return {};
  };
  Object.prototype.cachedData = new Uint8Array([1, 2, 3, 4]);
  Object.prototype.produceCachedData = true;
  let out;
  try {
    const r = ctx.sync.runScript('{ const t = Date.now(); while (Date.now() - t < 50); } import("node:fs")');
    out = await r.value.then(() => 'loaded', (err) => 'rejected ' + err.code);
  } catch (err) {
    out = 'threw ' + (err.code ?? err.message);
  }
  for (const k of ['timeout', 'importModuleDynamically', 'cachedData', 'produceCachedData']) delete Object.prototype[k];
  await ctx.write(1, JSON.stringify([out, spied]));
  return 0;
};`;

test("ctx.sync.runScript's options can't be set through Object.prototype: a timeout, an import callback and cached code a program puts there are not used (#1541)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/rp/package.json',
    JSON.stringify({ name: 'rp', slicc: { commands: { rp: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/rp/main.mjs', POLLUTER);
  const r = await kernel.run(['rp'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['rejected ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 0]);
});
