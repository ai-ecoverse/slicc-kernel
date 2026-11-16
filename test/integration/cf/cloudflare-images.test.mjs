import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev, until } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';
import { messageWasm, whole } from './message-wasm.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const PROGRAM = '/bin/msg.wasm';
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
const RUN = crypto.randomUUID().slice(0, 6);
let dev;
let processHost;
let call;

const variant = (text) => [...whole(messageWasm(`msg ${text}\n`, { tag: RUN }))];
const put = (text) => call('/kernel/tree-put', { path: PROGRAM, bytes: variant(text) });
const run = (argv) => call('/kernel/run', { argv });
const opens = async () =>
  (await call('/kernel/tree-reads', {})).reads.filter((path) => path === PROGRAM).length;

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (dev.skip) return;
  call = client(dev);
  const booted = await call('/kernel/boot', {
    commands: ['/image/node_modules'],
    max: 1,
    waitMs: 30_000,
  });
  assert.equal(booted.status, 200, JSON.stringify(booted));
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    const to = `/node_modules/@ai-ecoverse/${name}`;
    await uploadTree(call, join(MODULES, name), to, programs, '/kernel/tree');
  }
  await put('A');
  const mounted = await call('/kernel/mount-tree', { target: '/image' });
  assert.equal(mounted.state, 'ok', JSON.stringify(mounted));
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built yet';
  if (why) t.skip(why);
  return Boolean(why);
};

async function held(argv) {
  await until(async () => (await call('/kernel/stats')).active === 0);
  const { id } = await call('/kernel/terminal', { argv });
  await until(async () => (await call('/kernel/stats')).active === 1);
  return {
    release: () => call('/kernel/write', { id, data: 'go\n' }),
    ended: () => until(async () => (await call('/kernel/output', { id })).ended ?? undefined),
  };
}

async function compiledThenChanged(letter, change) {
  await put(letter);
  const busy = await held(['bash', '-c', 'read x']);
  const before = (await call('/kernel/stats')).images;
  const running = run([`/image${PROGRAM}`]);
  await until(async () => (await call('/kernel/stats')).images > before);
  await change();
  await busy.release();
  const result = await running;
  await busy.ended();
  return result;
}

describe('the Durable Object keeps no program bytes', { concurrency: false }, () => {
  test('a program runs, Images holds none of its bytes, and only its cold start reads it again', async (t) => {
    if (skipped(t)) return;
    await opens();
    const first = await run([`/image${PROGRAM}`]);
    assert.deepEqual(
      { status: first.status, stdout: first.stdout, stderr: first.stderr },
      { status: 0, stdout: 'msg A\n', stderr: '' }
    );
    const cold = await opens();
    const second = await run([`/image${PROGRAM}`]);
    assert.equal(second.stdout, 'msg A\n', JSON.stringify(second));
    const warm = await opens();
    t.diagnostic(`opens of the program: ${cold} for the cold start, ${warm} warm`);
    assert.equal(cold, warm + 2);
    const echoed = await run(['bash', '-c', 'echo hi']);
    assert.equal(echoed.stdout, 'hi\n', JSON.stringify(echoed));
    const stats = await call('/kernel/stats');
    assert.ok(stats.images >= 2, JSON.stringify(stats));
    assert.equal(stats.held, 0);
  });

  test('a program whose file changed before its cold start fails with ESTALE, and the next run reads the new file', async (t) => {
    if (skipped(t)) return;
    const failed = await compiledThenChanged('BB', () => put('CCC'));
    assert.equal(failed.status, 126, JSON.stringify(failed));
    assert.match(
      failed.stderr,
      /ESTALE: \/image\/bin\/msg\.wasm changed since the kernel compiled it/
    );
    const next = await run([`/image${PROGRAM}`]);
    assert.deepEqual(
      { status: next.status, stdout: next.stdout },
      { status: 0, stdout: 'msg CCC\n' }
    );
  });

  test('a program whose file is gone before its cold start fails with ENOENT', async (t) => {
    if (skipped(t)) return;
    const failed = await compiledThenChanged('DDDD', () =>
      call('/kernel/tree-drop', { path: PROGRAM })
    );
    assert.equal(failed.status, 127, JSON.stringify(failed));
    assert.match(
      failed.stderr,
      /ENOENT: \/image\/bin\/msg\.wasm is gone since the kernel compiled it/
    );
    await put('EEEEE');
    const back = await run([`/image${PROGRAM}`]);
    assert.deepEqual(
      { status: back.status, stdout: back.stdout },
      { status: 0, stdout: 'msg EEEEE\n' }
    );
  });
});
