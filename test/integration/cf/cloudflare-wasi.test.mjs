import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const FILES = 200;
const PYTHON_SKIPPED = new Set([
  '__pycache__',
  'test',
  'idlelib',
  'ensurepip',
  'site-packages',
  'tkinter',
  'turtledemo',
  'pydoc_data',
  'lib2to3',
]);
let dev;
let call;
let processHost;

const wall = async (work) => {
  const started = performance.now();
  const value = await work();
  return { ms: Math.round(performance.now() - started), value };
};

const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');

function python(path, dir) {
  if (path === 'package.json' || path === 'bin' || path === 'bin/python.wasm') return true;
  if (path === 'lib' || path === 'lib/python3.15') return true;
  if (!path.startsWith('lib/python3.15/')) return false;
  const name = path.split('/').at(-1);
  return !(dir && PYTHON_SKIPPED.has(name));
}

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (dev.skip) return;
  call = client(dev);
  assert.equal((await call('/kernel/boot', { persist: true })).status, 200);
  for (const name of ['wasi-ripgrep', 'wasm-bash', 'wasm-coreutils']) {
    await uploadTree(call, join(MODULES, name), `/node_modules/@ai-ecoverse/${name}`, programs);
  }
  const tree = [];
  for (let i = 0; i < FILES; i++) {
    tree.push(
      `/root/tree/d${i % 10}/f${i}.txt`,
      `line one\n${i % 3 === 0 ? 'needle' : 'hay'} ${i}\n`
    );
  }
  for (let i = 0; i < tree.length; i += 2) {
    await call('/kernel/file-write', { path: tree[i], data: tree[i + 1] });
  }
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built yet (workstream B2)';
  if (why) t.skip(why);
  return Boolean(why);
};

const run = (argv) => call('/kernel/run', { argv });

describe('WASI programs in Dynamic Workers over the SQLite root', { concurrency: false }, () => {
  test('rg searches a tree on the SQLite root, cold and warm', async (t) => {
    if (skipped(t)) return;
    const needles = Math.ceil(FILES / 3);
    const cold = await wall(() => run(['rg', '-l', 'needle', '/root/tree']));
    assert.equal(cold.value.status, 0, cold.value.stderr);
    assert.equal(cold.value.stdout.trim().split('\n').length, needles);
    const warm = await wall(() => run(['rg', '-c', 'needle', '/root/tree']));
    assert.equal(warm.value.status, 0, warm.value.stderr);
    assert.equal(warm.value.stdout.trim().split('\n').length, needles);
    t.diagnostic(`rg over ${FILES} files: cold ${cold.ms} ms, warm ${warm.ms} ms`);
  });

  test('a pipeline of two WASI programs under bash', async (t) => {
    if (skipped(t)) return;
    const script = 'rg -l needle /root/tree | rg -c "d[0-4]/"';
    const first = await wall(() => run(['bash', '-c', script]));
    assert.equal(first.value.status, 0, first.value.stderr);
    const expected = Array.from({ length: FILES }, (_, i) => i).filter(
      (i) => i % 3 === 0 && i % 10 < 5
    ).length;
    assert.equal(first.value.stdout, `${expected}\n`);
    const again = await wall(() => run(['bash', '-c', script]));
    assert.equal(again.value.stdout, `${expected}\n`);
    t.diagnostic(`bash -c 'rg | rg': first ${first.ms} ms, warm ${again.ms} ms`);
  });

  test('python -c in a Dynamic Worker', async (t) => {
    if (skipped(t)) return;
    const upload = await wall(() =>
      uploadTree(
        call,
        join(MODULES, 'wasix-python'),
        '/node_modules/@ai-ecoverse/wasix-python',
        python
      )
    );
    t.diagnostic(`installed ${upload.value} python files in ${upload.ms} ms`);
    const code =
      'import sys, json; print(json.dumps({"sum": sum(range(10)), "v": sys.version_info[:2]}))';
    const cold = await wall(() => run(['python', '-c', code]));
    if (
      process.env.SLICC_CF_FIXTURE_URL &&
      /cannot allocate memory/.test(cold.value.stderr ?? '')
    ) {
      t.skip('python.wasm imports a 160 MiB shared memory, above the 128 MB isolate limit');
      return;
    }
    assert.equal(cold.value.status, 0, JSON.stringify(cold.value).slice(0, 2000));
    assert.deepEqual(JSON.parse(cold.value.stdout), { sum: 45, v: [3, 15] });
    const warm = await wall(() => run(['python', '-c', 'print(6 * 7)']));
    assert.equal(warm.value.stdout, '42\n');
    t.diagnostic(`python -c: cold ${cold.ms} ms, warm ${warm.ms} ms`);
  });
});
