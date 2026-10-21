import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const filler = Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i};`).join('\n');
const PROGRAM = `${filler}
export default async function main(ctx) {
  const reach = await import('node:worker_threads').then(() => 'reached', (e) => e.code);
  await ctx.write(1, reach);
  return 0;
}
`;

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out.push([path, (await stat(path)).mtimeMs]);
    }
  }
  return out;
}

async function kernelWith(t, options) {
  const kernel = await createNodeKernel({ users: 'off', ...options });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/cc/package.json',
    JSON.stringify({ name: 'cc', slicc: { commands: { cc: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/cc/main.mjs', PROGRAM);
  return kernel;
}

test("createNodeKernel's opt-in compileCache keeps a JS program's compiled code in the given directory, so a second spawn reuses it, and the program can't reach the worker's data (#1285)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-cc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const kernel = await kernelWith(t, { compileCache: dir });
  const first = await kernel.run(['cc'], { cwd: '/' });
  assert.deepEqual([first.status, first.stdout], [0, 'ERR_ACCESS_DENIED'], first.stderr);
  const written = await files(dir);
  assert.ok(written.length > 0, 'the first spawn wrote its compiled program');
  const second = await kernel.run(['cc'], { cwd: '/' });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    await files(dir),
    written,
    'the second spawn read the cache and wrote nothing new'
  );
});

test("without compileCache nothing is cached, not even when a program's own env names NODE_COMPILE_CACHE, and a compileCache that is not an absolute path is refused (#1285)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-cc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const kernel = await kernelWith(t, {});
  const r = await kernel.run(['cc'], { cwd: '/', env: { NODE_COMPILE_CACHE: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await files(dir), []);
  await assert.rejects(
    createNodeKernel({ compileCache: 'relative/dir' }),
    /compileCache must be an absolute directory path/
  );
});

test("a host started with NODE_COMPILE_CACHE doesn't hand it to the process workers: the program goes only into compileCache's directory, never the host's (#1334 review)", async (t) => {
  const host = await mkdtemp(join(tmpdir(), 'slicc-cc-host-'));
  const own = await mkdtemp(join(tmpdir(), 'slicc-cc-own-'));
  t.after(() => rm(host, { recursive: true, force: true }));
  t.after(() => rm(own, { recursive: true, force: true }));
  const script = join(own, '..', `slicc-cc-host-${process.pid}.mjs`);
  t.after(() => rm(script, { force: true }));
  const dist = new URL('../../dist/node.js', import.meta.url).href;
  await writeFile(
    script,
    `const { createNodeKernel } = await import(${JSON.stringify(dist)});
const k = await createNodeKernel({ users: 'off', compileCache: process.argv[2] });
await k.writeFile('/node_modules/cc/package.json', ${JSON.stringify(JSON.stringify({ name: 'cc', slicc: { commands: { cc: { abi: 'js', module: 'main.mjs' } } } }))});
await k.writeFile('/node_modules/cc/main.mjs', 'export default async () => 0;');
if (process.argv[3] === 'run') console.log((await k.run(['cc'], { cwd: '/' })).status);
k.terminate();
`
  );
  const go = (mode) =>
    spawnSync(process.execPath, [script, own, mode], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_COMPILE_CACHE: host },
    });
  assert.equal(go('idle').status, 0);
  const hostOnly = (await files(host)).length;
  const ran = go('run');
  assert.equal(ran.stdout.trim(), '0', ran.stderr);
  assert.equal(
    (await files(host)).length,
    hostOnly,
    "the worker wrote nothing into the host's NODE_COMPILE_CACHE"
  );
  assert.ok(
    (await files(own)).length > 0,
    "the program's compiled code is in compileCache's directory"
  );
});
