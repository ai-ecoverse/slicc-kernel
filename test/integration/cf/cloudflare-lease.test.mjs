import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cliFiles, exerciseCli, externalCli } from '../lease-cli.mjs';
import { client, startDev } from './cloudflare-fixture/dev.mjs';
import { uploadFiles } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));

async function install(call) {
  const files = await Promise.all(
    ['probe.wasm', 'package.json'].map(async (name) => [
      `/node_modules/leaseprobe/${name}`,
      await readFile(new URL(`../fixtures/leaseprobe/${name}`, import.meta.url)),
    ])
  );
  await uploadFiles(call, files);
}

test('a local Durable Object runs the lease facade for its bound WASI job, without a network transport', async (t) => {
  const dev = await startDev(config);
  assert.ok(!dev.skip, dev.skip);
  t.after(() => dev.stop());
  const call = client(dev);
  const boot = await call('/kernel/boot', { leaseFixture: true });
  assert.equal(boot.status, 200, JSON.stringify(boot));
  await install(call);
  const request = {
    id: 1,
    method: 'Slicc.leaseRequest',
    params: { allow: [{ kind: 'origin', url: 'https://billing.example' }], ttlSeconds: 3600 },
  };
  const ws = async (...commands) => {
    const r = await call('/kernel/job-run', {
      argv: ['leaseprobe', 'ws', '', ...commands.map((c) => JSON.stringify(c))],
    });
    assert.equal(r.status, 0, JSON.stringify(r));
    return JSON.parse(r.stdout);
  };
  const [{ result }] = await ws(request);
  assert.equal(result.request, 'R1');
  assert.match(result.jkt, /^[A-Za-z0-9_-]{43}$/);
  const [snap, raw] = await ws(
    {
      id: 2,
      method: 'Slicc.leaseAction',
      params: { lease: result.lease, op: 'snapshot', args: {} },
    },
    { id: 3, method: 'Target.getTargets', params: {} }
  );
  assert.deepEqual(snap, { id: 2, result: { result: { text: 'fixture document' } } });
  assert.equal(raw.error.data.reason, 'E_UNSUPPORTED');
  const denied = await call('/kernel/run', { argv: ['leaseprobe', 'get', '/json/version'] });
  assert.equal(denied.status, 0, JSON.stringify(denied));
  assert.match(denied.stdout, /^403\n/);
  assert.doesNotMatch(denied.stdout, /DebuggerUrl/);

  const other = client(dev);
  assert.equal((await other('/kernel/boot', { leaseFixture: true })).status, 200);
  await install(other);
  const foreignHandle = {
    id: 2,
    method: 'Slicc.leaseAction',
    params: { lease: result.lease, op: 'snapshot', args: {} },
  };
  const distinct = await other('/kernel/job-run', {
    argv: ['leaseprobe', 'ws', '', JSON.stringify(request), JSON.stringify(foreignHandle)],
  });
  assert.equal(distinct.status, 0, JSON.stringify(distinct));
  const [separate, rejected] = JSON.parse(distinct.stdout);
  assert.notEqual(separate.result.jkt, result.jkt);
  assert.notEqual(separate.result.lease, result.lease);
  assert.equal(rejected.error.data.reason, 'E_REVOKED');

  await t.test(
    'matching branch playwright-cli.wasm uses the same DO hook',
    { skip: !externalCli },
    async () => {
      await uploadFiles(call, await cliFiles());
      await exerciseCli((argv) => call('/kernel/job-run', { argv }), result);
    }
  );
});
