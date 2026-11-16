import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev } from './cloudflare-fixture/dev.mjs';
import { uploadFiles } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const FIXTURE = new URL('../fixtures/hostcall/', import.meta.url);
const FILES = ['package.json', 'bin/hostcall.wasm', 'host/hostcall-host.mjs', 'host/sync-only.mjs'];
let dev;
let processHost;
let call;

const run = async (argv) => {
  const r = await call('/kernel/run', { argv });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(r.thrown ? { thrown: r.thrown } : {}),
  };
};
const hostcall = async (request, command = 'hostcall') => {
  const r = await run([command, JSON.stringify(request)]);
  assert.equal(r.status, 0, JSON.stringify(r));
  return JSON.parse(r.stdout);
};

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (dev.skip) return;
  call = client(dev);
  assert.equal((await call('/kernel/boot', { network: true })).status, 200);
  const files = [];
  for (const file of FILES) {
    files.push([`/node_modules/hostcall/${file}`, await readFile(new URL(file, FIXTURE))]);
  }
  await uploadFiles(call, files);
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built yet (workstream B2)';
  if (why) t.skip(why);
  return Boolean(why);
};

describe('a WASI program with an imports module, in a Dynamic Worker', {
  concurrency: false,
}, () => {
  test('the Dynamic Worker loads the imports module and its async functions suspend the program', async (t) => {
    if (skipped(t)) return;
    assert.deepEqual(await hostcall({ op: 'echo' }), {
      ok: true,
      value: { argv: ['hostcall', '{"op":"echo"}'], cwd: '/' },
    });
    assert.deepEqual(
      await hostcall({ op: 'exists', path: '/node_modules/hostcall/package.json' }),
      {
        ok: true,
        value: true,
      }
    );
    assert.deepEqual(await hostcall({ op: 'nope' }), {
      ok: false,
      error: 'unknown operation nope',
    });
  });

  test("its HTTP goes through the kernel's transport, headers and all", async (t) => {
    if (skipped(t)) return;
    await call('/kernel/fetched', {});
    const answer = await hostcall({
      op: 'http',
      url: 'https://example.test/repos/cli/cli',
      headers: [['x-test', 'token PLACEHOLDER']],
    });
    assert.deepEqual(answer, {
      ok: true,
      value: { status: 200, body: 'GET https://example.test/repos/cli/cli token PLACEHOLDER \n' },
    });
    assert.deepEqual((await call('/kernel/fetched', {})).fetched, [
      'GET https://example.test/repos/cli/cli',
    ]);
  });

  test('a process it spawns runs, and its output comes back through a pipe', async (t) => {
    if (skipped(t)) return;
    const answer = await hostcall({ op: 'run', argv: ['hostcall', '{"op":"echo"}'] });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.value.status, 0);
    assert.deepEqual(JSON.parse(answer.value.stdout), {
      ok: true,
      value: { argv: ['hostcall', '{"op":"echo"}'], cwd: '/' },
    });
  });

  test('a module with only createImports is refused with 126 and a message', async (t) => {
    if (skipped(t)) return;
    assert.deepEqual(await run(['hostcall-sync', '{}']), {
      status: 126,
      stdout: '',
      stderr:
        'the imports module exports no createAsyncImports function, which the async process host calls\n',
    });
  });

  test('another imports module for the same wasm gets a Dynamic Worker of its own', async (t) => {
    if (skipped(t)) return;
    const before = (await call('/kernel/stats', {})).loads;
    const source = await readFile(new URL('host/hostcall-host.mjs', FIXTURE), 'utf8');
    await uploadFiles(call, [
      ['/node_modules/hostcall/host/hostcall-host.mjs', `${source}\n// changed\n`],
    ]);
    assert.deepEqual(await hostcall({ op: 'echo' }), {
      ok: true,
      value: { argv: ['hostcall', '{"op":"echo"}'], cwd: '/' },
    });
    assert.equal((await call('/kernel/stats', {})).loads, before + 1);
    await uploadFiles(call, [['/node_modules/hostcall/host/hostcall-host.mjs', source]]);
  });
});
