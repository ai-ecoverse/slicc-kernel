import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const SOURCE = `
const collect = (sites) => sites.flatMap((site) => [
  site.getFileName(), site.getScriptNameOrSourceURL(), site.getEvalOrigin(), site.toString(),
]).filter((value) => typeof value === 'string');
const probe = async (ctx) => {
  const out = { globals: [], stacks: {}, sites: {}, named: [] };
  const seen = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.includes('file:') || value.includes(${JSON.stringify(DIST)})) out.globals.push(value);
      return;
    }
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      visit(typeof key === 'symbol' ? key.description : key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor) {
        visit(descriptor.value);
        visit(descriptor.get);
        visit(descriptor.set);
        if (descriptor.get && value === globalThis) {
          try { visit(Reflect.get(value, key)); } catch {}
        }
      }
    }
    visit(Object.getPrototypeOf(value));
  };
  visit(globalThis);
  const errors = {
    sync: () => { try { ctx.sync.open('/missing/callsite'); } catch (error) { return error; } },
    async: async () => { try { await ctx.fs.readFile('/missing/callsite'); } catch (error) { return error; } },
    script: () => { try { ctx.sync.runScript('throw new Error("script")', { filename: 'probe.js' }); } catch (error) { return error; } },
    own: () => ctx.asyncContext.run(null, () => new Error('own')),
  };
  for (const mode of ['default', 'own', 'formatter', 'formatterOwn']) {
    let sites = [];
    const prepare = (error, trace) => {
      sites.push(...collect(trace));
      return error.message + '\\n' + trace.map(String).join('\\n');
    };
    if (mode === 'own' || mode === 'formatterOwn') Error.prepareStackTrace = prepare;
    else delete Error.prepareStackTrace;
    if (mode === 'formatter') ctx.sync.setStackFormatter(prepare);
    else if (mode === 'formatterOwn') ctx.sync.setStackFormatter((error, trace, own) => own(error, trace), { own: true });
    else ctx.sync.setStackFormatter(null);
    for (const [kind, make] of Object.entries(errors)) {
      sites = [];
      const error = await make();
      out.stacks[mode + ':' + kind] = String(error.stack);
      out.sites[mode + ':' + kind] = sites;
      if (mode === 'own') out.named.push(sites.some((name) => name.includes('slicc-kernel:/node-process-worker.js')));
    }
  }
  delete Error.prepareStackTrace;
  ctx.sync.setStackFormatter(null);
  return out;
};
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    ctx.thread.port.postMessage(await probe(ctx));
    await new Promise(() => {});
  }
  let out;
  if (ctx.argv[1] === 'thread') {
    const thread = await ctx.thread.spawn({});
    out = await new Promise((resolve) => { thread.port.onmessage = (event) => resolve(event.data); });
    await thread.terminate();
  } else out = await probe(ctx);
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

for (const where of ['process', 'thread']) {
  test(`NEGATIVE: program-visible stack and CallSite paths and reachable global strings in a Node ${where} (#1656)`, async (t) => {
    const kernel = await createNodeKernel({ users: 'off' });
    t.after(() => kernel.terminate());
    await kernel.writeFile(
      '/node_modules/kcp/package.json',
      JSON.stringify({
        name: 'kcp',
        slicc: { commands: { kcp: { abi: 'js', module: 'main.mjs' } } },
      })
    );
    await kernel.writeFile('/node_modules/kcp/main.mjs', SOURCE);
    const result = await kernel.run(['kcp', where], { cwd: '/' });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(out.globals, []);
    assert.deepEqual(out.named, [true, true, true, true]);
    assert.equal(Object.keys(out.stacks).length, 16);
    for (const [key, stack] of Object.entries(out.stacks)) {
      assert.ok(!stack.includes('file:') && !stack.includes(DIST), `${key}: ${stack}`);
      if (key.startsWith('default:')) assert.match(stack, /slicc-kernel:\/node-process-worker\.js/);
    }
    for (const [key, sites] of Object.entries(out.sites)) {
      if (!key.startsWith('default:')) assert.ok(sites.length > 0, key);
      for (const site of sites) {
        assert.ok(!site.includes('file:') && !site.includes(DIST), `${key}: ${site}`);
      }
    }
  });
}

test('Node preloads run before programs, require then import, on the default boot and an explicit ESM worker (#1656)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-kcp-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'pre.cjs'), "globalThis.__preloadOrder = ['require'];\n");
  await writeFile(join(dir, 'pre.mjs'), "globalThis.__preloadOrder.push('import');\n");
  const host = join(dir, 'host.mjs');
  await writeFile(
    host,
    `
const { createNodeKernel } = await import(${JSON.stringify(new URL('../../dist/node.js', import.meta.url).href)});
const out = [];
for (const worker of [undefined, new URL(${JSON.stringify(new URL('../../dist/node-process-worker.js', import.meta.url).href)})]) {
  const kernel = await createNodeKernel({ users: 'off', ...(worker ? { worker } : {}) });
  try {
    await kernel.writeFile('/node_modules/order/package.json', JSON.stringify({ name: 'order', slicc: { commands: { order: { abi: 'js', module: 'main.mjs' } } } }));
    await kernel.writeFile('/node_modules/order/main.mjs', 'export default async (ctx) => { await ctx.write(1, JSON.stringify(globalThis.__preloadOrder)); return 0; };');
    out.push(await kernel.run(['order'], { cwd: '/' }));
  } finally { kernel.terminate(); }
}
console.log(JSON.stringify(out));
`
  );
  const result = spawnSync(
    process.execPath,
    ['--require', './pre.cjs', '--import', './pre.mjs', host],
    { cwd: dir, encoding: 'utf8', timeout: 60_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const out = JSON.parse(result.stdout);
  assert.equal(out.length, 2);
  for (const run of out) {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ['require', 'import']);
  }
});
