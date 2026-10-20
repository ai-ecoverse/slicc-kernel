import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import * as testing from '../../dist/testing.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

const IDLE = 5000;
const HOLD = 3000;
const SLEEP_MS = 3000;

test('a spawn beyond the wasm-memory ceiling waits while the processes ahead of it are still starting, and gets in when one ends, instead of EAGAIN (#1196, #970)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({
    users: 'off',
    wasmMemories: { ceiling: 2, idleMs: IDLE },
  });
  t.after(() => kernel.terminate());
  t.after(() => testing.setTestSyscallHook(undefined));
  await install(kernel, 'wasm-coreutils');
  assert.equal((await kernel.run(['sleep', '0'], { cwd: '/' })).status, 0);
  const holds = [HOLD, HOLD];
  const held = new Map();
  testing.setTestSyscallHook(async ({ pid }) => {
    if (!held.has(pid)) held.set(pid, holds.length > 0 ? holds.shift() : 0);
    const ms = held.get(pid);
    if (ms > 0) {
      held.set(pid, 0);
      await new Promise((r) => setTimeout(r, ms));
    }
  });
  const started = Date.now();
  const runs = await Promise.all(
    [0, 1, 2].map((i) =>
      new Promise((r) => setTimeout(r, i * 50))
        .then(() => kernel.run(['sleep', String(SLEEP_MS / 1000)], { cwd: '/' }))
        .then(
          (r) => r.status,
          (e) => e.code ?? String(e)
        )
    )
  );
  assert.deepEqual(runs, [0, 0, 0], `after ${Date.now() - started} ms`);
});

const POOL = `const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const live = (ctx) => Number(new TextDecoder().decode(ctx.sync.fs.readFile('/proc/sys/kernel/slicc_wasm_memories')).split(' ')[0]);
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    await new Promise(() => {});
  }
  const mode = ctx.argv[1];
  if (mode === 'hold') {
    await pause(Number(ctx.argv[2]));
    return 0;
  }
  const out = { before: live(ctx) };
  const a = await ctx.thread.spawn({});
  const b = await ctx.thread.spawn({});
  out.two = live(ctx);
  let third = 'waiting';
  const c = ctx.thread.spawn({}).then((t) => { third = 'spawned'; return t; }, (e) => { third = e.code; });
  await pause(mode === 'wait' ? 400 : 3000);
  out.early = third;
  if (mode === 'wait') {
    await a.terminate();
    const t = await c;
    out.after = third;
    await t.terminate();
  }
  await b.terminate();
  if (mode !== 'wait') await a.terminate();
  await pause(50);
  out.end = live(ctx);
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

async function pool(t, options) {
  const kernel = await createNodeKernel({ users: 'off', ...options });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/pool/package.json',
    JSON.stringify({
      name: 'pool',
      slicc: { commands: { pool: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/pool/main.mjs', POOL);
  return kernel;
}

test('a JS thread takes a slot of the wasm-memory ceiling: at the ceiling thread.spawn waits, and gets in once a thread ends (#1133)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await pool(t, { wasmMemories: { ceiling: 3, idleMs: 1500 } });
  const r = await kernel.run(['pool', 'wait'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    before: 1,
    two: 3,
    early: 'waiting',
    after: 'spawned',
    end: 1,
  });
});

test('at the ceiling with nothing starting or ending, thread.spawn rejects with EAGAIN after the quiet spell (#1133)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await pool(t, { wasmMemories: { ceiling: 3, idleMs: 1500 } });
  const r = await kernel.run(['pool', 'quiet'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { before: 1, two: 3, early: 'EAGAIN', end: 1 });
});

test('a JS process takes a slot too: with two JS processes live at a ceiling of 2, a wasm sleep waits until one ends (#1133)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await pool(t, { wasmMemories: { ceiling: 2, idleMs: 5000 } });
  await install(kernel, 'wasm-coreutils');
  const started = Date.now();
  const holds = [
    kernel.run(['pool', 'hold', '1500'], { cwd: '/' }),
    kernel.run(['pool', 'hold', '1500'], { cwd: '/' }),
  ];
  await new Promise((r) => setTimeout(r, 300));
  const sleep = await kernel.run(['sleep', '0'], { cwd: '/' });
  const waited = Date.now() - started;
  assert.equal(sleep.status, 0, sleep.stderr);
  assert.deepEqual(
    (await Promise.all(holds)).map((h) => h.status),
    [0, 0]
  );
  assert.ok(waited >= 1400, `the wasm sleep ran after ${waited} ms, before a JS process ended`);
});
