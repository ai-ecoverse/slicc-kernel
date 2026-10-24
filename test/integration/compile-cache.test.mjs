import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

test("compileCache: false caches nothing, not even when a program's own env names NODE_COMPILE_CACHE, and a compileCache that is neither an absolute path nor false is refused (#1285, #1597)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-cc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const kernel = await kernelWith(t, { compileCache: false });
  const r = await kernel.run(['cc'], { cwd: '/', env: { NODE_COMPILE_CACHE: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await files(dir), []);
  await assert.rejects(
    createNodeKernel({ compileCache: 'relative/dir' }),
    /compileCache must be an absolute directory path or false/
  );
});

const CHILD = `
const { createNodeKernel } = await import(process.env.DIST);
const { readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');
const base = process.env.TMPDIR;
const mine = () => readdirSync(base).filter((n) => n.startsWith('slicc-kernel-cc-' + process.pid + '-'));
const off = await createNodeKernel({ users: 'off', compileCache: false });
const noneWhenOff = mine().length;
off.terminate();
const kernel = await createNodeKernel({ users: 'off' });
await kernel.writeFile('/node_modules/cc/package.json', JSON.stringify({ name: 'cc', slicc: { commands: { cc: { abi: 'js', module: 'main.mjs' } } } }));
await kernel.writeFile('/node_modules/cc/main.mjs', process.env.PROGRAM);
const r = await kernel.run(['cc'], { cwd: '/' });
await kernel.run(['cc'], { cwd: '/' });
const [dir] = mine();
const cached = readdirSync(join(base, dir), { recursive: true }).length > 0;
const mode = (statSync(join(base, dir)).mode & 0o777).toString(8);
kernel.terminate();
await new Promise((resolve) => setTimeout(resolve, 200));
console.log(JSON.stringify({ status: r.status, out: r.stdout, noneWhenOff, owned: mine().length === 0 ? 'gone' : 'left', cached, mode, left: readdirSync(base).sort() }));
`;

test('by default a Node kernel caches compiled programs in a private directory of its own under the host temp dir (0700, removed on terminate), and sweeps such directories whose process is gone; compileCache: false makes none (#1597)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'slicc-ccbase-'));
  const scripts = await mkdtemp(join(tmpdir(), 'slicc-ccchild-'));
  try {
    const child = join(scripts, 'child.mjs');
    await writeFile(child, CHILD);
    await mkdir(join(base, 'slicc-kernel-cc-2147483646-stale'), { recursive: true });
    await writeFile(join(base, 'slicc-kernel-cc-2147483646-stale', 'x'), 'x');
    await mkdir(join(base, `slicc-kernel-cc-${process.pid}-alive`), { recursive: true });
    await mkdir(join(base, 'unrelated'), { recursive: true });
    const r = spawnSync(process.execPath, [child], {
      env: {
        ...process.env,
        TMPDIR: base,
        DIST: new URL('../../dist/node.js', import.meta.url).href,
        PROGRAM,
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      status: 0,
      out: 'ERR_ACCESS_DENIED',
      noneWhenOff: 0,
      owned: 'gone',
      cached: true,
      mode: '700',
      left: [`slicc-kernel-cc-${process.pid}-alive`, 'unrelated'],
    });
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(scripts, { recursive: true, force: true });
  }
});

test("a host started with NODE_COMPILE_CACHE doesn't hand it to the process workers: the program goes only into compileCache's directory, never the host's; a host preload that enables its own cache makes the worker refuse to run programs (#1334 review)", async (t) => {
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
if (process.argv[3] === 'run') { const r = await k.run(['cc'], { cwd: '/' }); console.log(r.status); console.log(r.stderr); }
k.terminate();
`
  );
  const go = (mode, flags = []) =>
    spawnSync(process.execPath, [...flags, script, own, mode], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_COMPILE_CACHE: host },
    });
  assert.equal(go('idle').status, 0);
  const hostOnly = (await files(host)).length;
  const ran = go('run');
  assert.equal(ran.stdout.split('\n')[0], '0', ran.stderr);
  assert.equal(
    (await files(host)).length,
    hostOnly,
    "the worker wrote nothing into the host's NODE_COMPILE_CACHE"
  );
  assert.ok(
    (await files(own)).length > 0,
    "the program's compiled code is in compileCache's directory"
  );
  const preload = join(own, '..', `slicc-cc-preload-${process.pid}.mjs`);
  t.after(() => rm(preload, { force: true }));
  await writeFile(
    preload,
    `import { enableCompileCache } from 'node:module';\nenableCompileCache(${JSON.stringify(host)});\n`
  );
  const refused = go('run', ['--import', preload]);
  assert.notEqual(
    refused.stdout.split('\n')[0],
    '0',
    'a worker whose cache a host preload chose runs no program'
  );
  assert.match(refused.stdout, /already caches in .*refusing to run programs/);
});
