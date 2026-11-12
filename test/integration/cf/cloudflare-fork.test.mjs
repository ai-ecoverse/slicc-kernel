import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev, until } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
const SCRIPT =
  '(true); x=$(echo hi); echo $x; for i in 1 2 3; do (echo $i); done | wc -l; (echo bg) & wait';
const SUBSTITUTIONS = 'for i in $(seq 20); do x=$(echo x); done; echo $x';
let dev;
let processHost;

const wall = async (work) => {
  const started = performance.now();
  const value = await work();
  return { ms: Math.round(performance.now() - started), value };
};

async function kernel(localForks, persist = false) {
  const call = client(dev);
  assert.equal((await call('/kernel/boot', { localForks, persist })).status, 200);
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    await uploadTree(call, join(MODULES, name), `/node_modules/@ai-ecoverse/${name}`, programs);
  }
  const run = (script) => call('/kernel/run', { argv: ['bash', '-c', script] });
  return { call, run };
}

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built yet (workstream B2)';
  if (why) t.skip(why);
  return Boolean(why);
};

async function settledForks(call) {
  return until(async () => {
    const forks = await call('/kernel/forks', {});
    return forks.held === 0 ? forks : undefined;
  });
}

describe('bash forks in Dynamic Workers', { concurrency: false }, () => {
  test('a fork keeps its memory snapshot in the isolate and the child takes it there', async (t) => {
    if (skipped(t)) return;
    const { call, run } = await kernel(true);
    await run('true');
    const r = await wall(() => run(SCRIPT));
    assert.deepEqual(
      { status: r.value.status, stdout: r.value.stdout, stderr: r.value.stderr },
      { status: 0, stdout: 'hi\n3\nbg\n', stderr: '' }
    );
    const forks = await settledForks(call);
    assert.ok(forks.taken >= 6, JSON.stringify(forks));
    assert.equal(forks.fetched, 0);
    const loop = await wall(() => run(SUBSTITUTIONS));
    assert.equal(loop.value.stdout, 'x\n');
    const one = await wall(() => run('(true)'));
    assert.equal(one.value.status, 0);
    t.diagnostic(`(true) ${one.ms} ms, script ${r.ms} ms, 20 substitutions ${loop.ms} ms`);
  });

  test('a child that does not find the snapshot locally pulls it from the parent', async (t) => {
    if (skipped(t)) return;
    const { call, run } = await kernel(false);
    const r = await wall(() => run(SCRIPT));
    assert.equal(r.value.stdout, 'hi\n3\nbg\n', JSON.stringify(r.value));
    const gone = await run('(sleep 0.3; echo after the parent) & exit 0');
    assert.equal(gone.status, 0);
    const forks = await settledForks(call);
    assert.equal(forks.taken, 0);
    assert.ok(forks.fetched >= 7, JSON.stringify(forks));
    const one = await wall(() => run('(true)'));
    t.diagnostic(`through the kernel: (true) ${one.ms} ms, script ${r.ms} ms`);
  });

  test('a seven- and an eight-stage pipeline with a redirect on the SQLite root', async (t) => {
    if (skipped(t)) return;
    const { call, run } = await kernel(true, true);
    await call('/kernel/file-write', { path: '/root/f', data: 'line\n'.repeat(100) });
    for (const stages of [7, 8]) {
      const script = `cd /root; cat f ${'| cat '.repeat(stages - 1)}> out${stages}; wc -l < out${stages}`;
      const r = await wall(() => run(script));
      assert.deepEqual(
        { status: r.value.status, stdout: r.value.stdout, stderr: r.value.stderr },
        { status: 0, stdout: '100\n', stderr: '' }
      );
      t.diagnostic(`${stages} stages: ${r.ms} ms`);
    }
    const again = await call('/kernel/file-read', { path: '/root/out7' });
    assert.equal(again.data, 'line\n'.repeat(100));
  });
});
