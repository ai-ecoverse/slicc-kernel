import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { client, REPO, startDev, until } from './cloudflare-fixture/dev.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));

async function bundledProcess() {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('./async-link-process.mjs', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    logLevel: 'warning',
    plugins: [
      {
        name: 'transport-from-src',
        setup(on) {
          on.onResolve({ filter: /dist\/node\.js$/ }, () => ({
            path: `${REPO}src/async/transport.ts`,
          }));
          on.onResolve({ filter: /^node:worker_threads$/ }, () => ({
            path: 'worker_threads',
            namespace: 'shim',
          }));
          on.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
            contents: 'export const isMainThread = true;',
          }));
        },
      },
    ],
  });
  return out.outputFiles[0].text;
}

let dev;
let call;
let bootMs;

before(async () => {
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (dev.skip) return;
  call = client(dev);
  const booted = await call('/kernel/boot', { process: await bundledProcess(), waitMs: 3000 });
  assert.equal(booted.status, 200, JSON.stringify(booted));
  bootMs = booted.bootMs;
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  if (!dev?.skip) return false;
  t.skip(dev.skip);
  return true;
};

async function terminal(argv) {
  const { id } = await call('/kernel/terminal', { argv });
  const output = async () => call('/kernel/output', { id });
  const seen = (text) =>
    until(async () => ((await output()).out.includes(text) ? output() : undefined));
  const ended = () => until(async () => (await output()).ended ?? undefined);
  return { id, output, seen, ended };
}

describe('the real kernel in a Durable Object with processes in Dynamic Workers', {
  concurrency: false,
}, () => {
  test('the kernel boots and a process makes syscalls through the RPC link', async (t) => {
    if (skipped(t)) return;
    t.diagnostic(`kernel boot and install ${bootMs} ms`);
    const r = await call('/kernel/run', { argv: ['fake', 'out'] });
    assert.deepEqual(
      { status: r.status, stdout: r.stdout, stderr: r.stderr },
      { status: 7, stdout: 'to stdout\n', stderr: 'to stderr\n' }
    );
    const id = await call('/kernel/run', { argv: ['fake', 'id', 'x'] });
    assert.equal(id.status, 0, id.stderr);
    const parsed = JSON.parse(id.stdout);
    assert.deepEqual(parsed.args, ['id', 'x']);
    const piped = await call('/kernel/run', {
      argv: ['fake', 'cat'],
      stdin: 'through the kernel\n',
    });
    assert.equal(piped.stdout, 'through the kernel\n');
  });

  test('connect returns a port that attachKernel drives', async (t) => {
    if (skipped(t)) return;
    const r = await call('/kernel/connect', { argv: ['fake', 'out'], user: 'root' });
    assert.equal(r.status, 7, JSON.stringify(r));
    assert.equal(r.stdout, 'to stdout\n');
    assert.ok(Array.isArray(r.mounts));
  });

  test('a blocking read is answered later', async (t) => {
    if (skipped(t)) return;
    const cat = await terminal(['fake', 'cat']);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal((await cat.output()).ended, null);
    await call('/kernel/write', { id: cat.id, data: 'typed late\n' });
    const out = await cat.seen('typed late');
    assert.match(out.out, /typed late/);
    await call('/kernel/signal', { id: cat.id, signal: 'SIGKILL' });
    await cat.ended();
  });

  test('a signal reaches a process blocked in the Dynamic Worker', async (t) => {
    if (skipped(t)) return;
    const waiter = await terminal(['fake', 'sigwait']);
    await waiter.seen('ready');
    await call('/kernel/signal', { id: waiter.id, signal: 'SIGUSR1' });
    const out = await waiter.seen('USR1');
    assert.match(out.out, /USR1/);
    const ended = await waiter.ended();
    assert.equal(ended.status, 0);
  });

  test('SIGKILL ends a hanging process and frees its isolate slot', async (t) => {
    if (skipped(t)) return;
    await until(async () => (await call('/kernel/stats')).active === 0);
    const hang = await terminal(['fake', 'hang']);
    await hang.seen('ready');
    assert.equal((await call('/kernel/stats')).active, 1);
    await call('/kernel/signal', { id: hang.id, signal: 'SIGKILL' });
    const ended = await hang.ended();
    assert.equal(ended.status, 137);
    await until(async () => (await call('/kernel/stats')).active === 0);
  });

  test('two processes of one image share one isolate', async (t) => {
    if (skipped(t)) return;
    const before = await call('/kernel/stats');
    const a = await terminal(['fake', 'hang']);
    const b = await terminal(['fake', 'hang']);
    await a.seen('ready');
    await b.seen('ready');
    const both = await call('/kernel/stats');
    assert.equal(both.active, 1);
    const piped = await call('/kernel/run', { argv: ['fake', 'pipe'] });
    assert.match(piped.stdout, /late/);
    assert.equal(piped.status, 0, piped.stderr);
    const after = await call('/kernel/stats');
    assert.equal(after.loads, before.loads);
    for (const term of [a, b]) await call('/kernel/signal', { id: term.id, signal: 'SIGKILL' });
  });

  test('eleven distinct images do not break the isolate limit', async (t) => {
    if (skipped(t)) return;
    await until(async () => (await call('/kernel/stats')).active === 0);
    const argvs = Array.from({ length: 11 }, (_, i) => [
      i === 0 ? 'fake' : `fake${i}`,
      'sleep',
      '1000',
    ]);
    const r = await call('/kernel/runs', { argvs });
    for (const result of r.results) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^slept (enough|short)\n$/);
    }
    const short = r.results.filter((result) => result.stdout.includes('short')).length;
    if (short) t.diagnostic(`${short} of 11 processes saw their clock advance less than 1000 ms`);
    assert.equal(r.peak, 8);
    t.diagnostic(`${r.loads} Dynamic Workers loaded, at most ${r.peak} in flight`);
  });

  test('a spawn that finds no isolate slot fails after the wait', async (t) => {
    if (skipped(t)) return;
    await until(async () => (await call('/kernel/stats')).active === 0);
    const hangs = [];
    for (let i = 1; i <= 8; i++) hangs.push(await terminal([`fake${i}`, 'hang']));
    for (const hang of hangs) await hang.seen('ready');
    const started = Date.now();
    const late = await call('/kernel/run', { argv: ['fake9', 'id'] });
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /EAGAIN/);
    assert.ok(Date.now() - started >= 2500);
    for (const hang of hangs) await call('/kernel/signal', { id: hang.id, signal: 'SIGKILL' });
  });

  test('terminate ends the kernel and its processes', async (t) => {
    if (skipped(t)) return;
    const hang = await terminal(['fake', 'hang']);
    await hang.seen('ready');
    await call('/kernel/terminate', {});
    await until(async () => (await call('/kernel/stats')).active === 0);
  });
});
