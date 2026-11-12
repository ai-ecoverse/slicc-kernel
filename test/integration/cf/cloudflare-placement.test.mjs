import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE, timedwaitsWasm, WAIT_MS } from './async-waits/timedwaits.mjs';
import { client, REPO, startDev, until } from './cloudflare-fixture/dev.mjs';
import { uploadFiles, uploadTree } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
const deployed = Boolean(process.env.SLICC_CF_FIXTURE_URL);
let dev;
let processHost;

const wall = async (work) => {
  const started = performance.now();
  const value = await work();
  return { ms: Math.round(performance.now() - started), value };
};

async function kernel(boot = {}) {
  const call = client(dev);
  assert.equal((await call('/kernel/boot', { persist: true, ...boot })).status, 200);
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    await uploadTree(call, join(MODULES, name), `/node_modules/@ai-ecoverse/${name}`, programs);
  }
  await call('/kernel/file-write', { path: '/root/f', data: 'line\n'.repeat(100) });
  const run = (script) => call('/kernel/run', { argv: ['bash', '-c', script] });
  return { call, run };
}

const shown = (r) => ({ status: r.status, stdout: r.stdout, stderr: r.stderr });
const pipeline = (stages) =>
  `cd /root; cat f ${'| cat '.repeat(stages - 1)}> out${stages}; wc -l < out${stages}`;

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

describe('placing processes by isolate memory', { concurrency: false }, () => {
  test('10- and 16-stage pipelines spread over isolates of one image', async (t) => {
    if (skipped(t)) return;
    const { call, run } = await kernel();
    for (const stages of [10, 16]) {
      const r = await wall(() => run(pipeline(stages)));
      assert.deepEqual(shown(r.value), { status: 0, stdout: '100\n', stderr: '' });
      t.diagnostic(`${stages} stages: ${r.ms} ms`);
    }
    const stats = await call('/kernel/stats', {});
    assert.ok(stats.peakShards >= 2, JSON.stringify(stats));
    assert.ok(stats.peak <= 8, JSON.stringify(stats));
    t.diagnostic(`at most ${stats.peakShards} isolates for one image, ${stats.peak} in flight`);
  });

  test('30 background jobs all print', async (t) => {
    if (skipped(t)) return;
    const { run } = await kernel();
    const r = await wall(() => run('for i in $(seq 30); do (sleep 1; echo $i) & done; wait'));
    assert.equal(r.value.status, 0, JSON.stringify(r.value).slice(0, 500));
    const printed = r.value.stdout
      .trim()
      .split('\n')
      .map(Number)
      .sort((a, b) => a - b);
    assert.deepEqual(
      printed,
      Array.from({ length: 30 }, (_, i) => i + 1)
    );
    t.diagnostic(`30 background jobs: ${r.ms} ms`);
  });

  test('a small budget moves fork children to another isolate, which pulls the snapshot', async (t) => {
    if (skipped(t)) return;
    const { call, run } = await kernel({ memory: 40 * 2 ** 20 });
    const r = await run('for i in 1 2 3; do (sleep 0.3; echo $i) & done; wait; (echo sub)');
    assert.equal(r.status, 0, JSON.stringify(r));
    assert.deepEqual(r.stdout.trim().split('\n').sort(), ['1', '2', '3', 'sub']);
    const forks = await until(async () => {
      const now = await call('/kernel/forks', {});
      return now.held === 0 ? now : undefined;
    });
    assert.ok(forks.fetched > 0, JSON.stringify(forks));
    assert.ok((await call('/kernel/stats', {})).peakShards >= 2);
  });

  test('an isolate that outgrows its limit loses its processes, and the rest carry on', async (t) => {
    if (skipped(t)) return;
    const { call, run } = await kernel();
    const { id } = await call('/kernel/terminal', { argv: ['sleep', '3'] });
    const size = deployed ? 200_000_000 : 20_000_000;
    const big = await run(`x=$(head -c ${size} /dev/zero | tr "\\0" a); echo \${#x}`);
    if (deployed) {
      assert.equal(big.status, 70, JSON.stringify(big).slice(0, 500));
      assert.match(big.stderr, /exceeded memory limit/);
    } else {
      assert.equal(big.stdout, `${size}\n`, JSON.stringify(big).slice(0, 500));
    }
    const sleeper = await until(async () => (await call('/kernel/output', { id })).ended, {
      timeoutMs: 30_000,
    });
    assert.equal(sleeper.status, 0);
    const after = await run(pipeline(3));
    assert.deepEqual(shown(after), { status: 0, stdout: '100\n', stderr: '' });
    t.diagnostic(`the large substitution ended with status ${big.status}`);
  });
});

describe('sleeping in a Dynamic Worker', { concurrency: false }, () => {
  test('sleep 1 between lines never ends early', async (t) => {
    if (skipped(t)) return;
    const clock = process.env.SLICC_CF_NO_CLOCK === undefined;
    const { call } = await kernel({ clock });
    const rounds = Number(process.env.SLICC_CF_SLEEP_ROUNDS ?? 1);
    const totals = [];
    const gaps = [];
    for (let round = 0; round < rounds; round++) {
      const started = performance.now();
      const { id } = await call('/kernel/terminal', {
        argv: [
          'bash',
          '-c',
          `${process.env.SLICC_CF_SLEEP_BEFORE ?? ''}for i in 1 2 3 4; do echo $i; sleep 1; done`,
        ],
      });
      const done = await until(
        async () => {
          const output = await call('/kernel/output', { id });
          return output.ended ? output : undefined;
        },
        { timeoutMs: 30_000, everyMs: 50 }
      );
      totals.push(Math.round(performance.now() - started));
      assert.equal(done.ended.status, 0);
      const lines = [];
      for (const [at, text] of done.stamps) {
        for (const line of text.split(/\r?\n/)) if (/^[1-4]$/.test(line)) lines.push([at, line]);
      }
      assert.deepEqual(
        lines.map(([, line]) => line),
        ['1', '2', '3', '4']
      );
      for (let i = 1; i < lines.length; i++) gaps.push(lines[i][0] - lines[i - 1][0]);
    }
    t.diagnostic(
      `totals ${totals.join(' ')} ms; gaps ${Math.min(...gaps)}..${Math.max(...gaps)} ms`
    );
    for (const total of totals) assert.ok(total >= 4000, `a round took ${total} ms`);
    for (const gap of gaps) assert.ok(gap >= 1000, `a gap of ${gap} ms`);
  });

  test('a WASI futex_wait and sigtimedwait with a timeout never end early', async (t) => {
    if (skipped(t)) return;
    const clock = process.env.SLICC_CF_NO_CLOCK === undefined;
    const { call } = await kernel({ clock });
    await uploadFiles(call, [
      ['/node_modules/timedwaits/package.json', JSON.stringify(PACKAGE)],
      ['/node_modules/timedwaits/bin/timedwaits.wasm', await timedwaitsWasm()],
    ]);
    const rounds = Number(process.env.SLICC_CF_SLEEP_ROUNDS ?? 1);
    const gaps = [];
    const totals = [];
    for (let round = 0; round < rounds; round++) {
      const started = performance.now();
      const { id } = await call('/kernel/terminal', { argv: ['timedwaits'] });
      const done = await until(
        async () => {
          const output = await call('/kernel/output', { id });
          return output.ended ? output : undefined;
        },
        { timeoutMs: 30_000, everyMs: 50 }
      );
      totals.push(Math.round(performance.now() - started));
      assert.equal(done.ended.status, 0, JSON.stringify(done).slice(0, 500));
      const lines = [];
      for (const [at, text] of done.stamps) {
        for (const line of text.split(/\r?\n/)) {
          if (/^(futex 0 0|sigwait 6 0)$/.test(line.replace(/ \d+ /, ' '))) lines.push([at, line]);
        }
      }
      assert.equal(lines.length, 8, done.out);
      for (let i = 1; i < lines.length; i++) gaps.push(lines[i][0] - lines[i - 1][0]);
    }
    t.diagnostic(
      `totals ${totals.join(' ')} ms; gaps ${Math.min(...gaps)}..${Math.max(...gaps)} ms`
    );
    for (const total of totals) assert.ok(total >= 8 * WAIT_MS, `a round took ${total} ms`);
    for (const gap of gaps) assert.ok(gap >= WAIT_MS, `a gap of ${gap} ms`);
  });
});
