import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { attachKernel, CDP_LEASE_VERSION, createNodeKernel } from '../../dist/node.js';
import { fixtureAdapter } from './fixtures/lease-adapter.mjs';
import { cliFiles, exerciseCli, externalCli } from './lease-cli.mjs';

test('matching branch WASI command calls only the stamped adapter', {
  skip: !externalCli,
}, async (t) => {
  const fixture = await fixtureAdapter();
  const kernel = await setup(t, { tag, adapter: fixture.adapter });
  for (const [path, data] of await cliFiles()) await kernel.writeFile(path, data);
  const client = await job(t, kernel);
  await exerciseCli((argv) => client.run(argv, { cwd: '/' }), fixture);
  assert.equal(fixture.seen.length, 6);
  assert.ok(fixture.seen.every(({ stamp }) => stamp.tag === tag && stamp.pid > 1));
});

const tag = 'lease:test-job';
const allow = [{ kind: 'origin', url: 'https://billing.example' }];
const params = { allow, ttlSeconds: 3600 };
const request = (p = params) => ({ id: 1, method: 'Slicc.leaseRequest', params: p });
const action = (lease, op, args) => ({
  id: 2,
  method: 'Slicc.leaseAction',
  params: { lease, op, args },
});

async function setup(t, cdpLease) {
  const kernel = await createNodeKernel(cdpLease ? { cdpLease } : {});
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'probe.wasm']) {
    await kernel.writeFile(
      `/node_modules/leaseprobe/${file}`,
      await readFile(new URL(`./fixtures/leaseprobe/${file}`, import.meta.url))
    );
  }
  return kernel;
}

async function run(runner, mode, command = '', options = {}, suffix = '') {
  const args =
    mode === 'ws'
      ? [suffix, ...command.map((c) => (typeof c === 'string' ? c : JSON.stringify(c)))]
      : [command];
  const result = await runner.run(['leaseprobe', mode, ...args], { cwd: '/', ...options });
  assert.equal(result.status, 0, result.stderr);
  const [line, ...rest] = result.stdout.split('\n');
  if (mode === 'get') return [Number(line), rest.join('\n')];
  if (mode === 'env') return [line || null, rest[0] || null];
  return JSON.parse(result.stdout);
}

async function job(t, kernel) {
  const client = await attachKernel(await kernel.connect({ tag }));
  t.after(() => client.close());
  return client;
}

test('lease-only boot admits one host-bound job, never a spawn tag, URL, or runtime', async (t) => {
  const fixture = await fixtureAdapter();
  const kernel = await setup(t, { tag, adapter: fixture.adapter });
  assert.equal(CDP_LEASE_VERSION, 1);
  await assert.rejects(kernel.connect(), /lease unavailable/);
  await assert.rejects(kernel.connect({ tag: 'other' }), /lease unavailable/);
  await assert.rejects(kernel.connect({ tag, requests: 'attach' }), /lease unavailable/);
  const client = await job(t, kernel);
  await assert.rejects(kernel.connect({ tag }), /lease unavailable/);
  await assert.rejects(
    client.serveCdp(
      async () => {
        throw new Error();
      },
      { runtime: 'other' }
    ),
    /lease-only/
  );
  await assert.rejects(client.dial({ port: 9222 }), /ECONNREFUSED/);
  const [endpoint, raw] = await run(client, 'env');
  assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:9222\/slicc\/lease\/v1\/[a-f0-9-]{36}$/);
  assert.equal(raw, null);
  const rawPath = new URL(endpoint).pathname.replace('/slicc/lease/v1/', '/devtools/browser/');
  for (const path of [
    '/json/version',
    '/json/list',
    '/json',
    new URL(endpoint).pathname,
    rawPath,
  ]) {
    const [status, body] = await run(kernel, 'get', path, { tag, env: { SLICC_TAG: tag } });
    assert.equal(status, 403);
    assert.doesNotMatch(body, /DebuggerUrl|target|slicc\/lease\/v1/);
  }
  assert.match((await run(kernel, 'ws', [request()], { tag })).refused, /403/);
  for (const path of [rawPath, '/json?runtime=other', '/json/version?runtime=other'])
    assert.equal((await run(client, 'get', path))[0], 404);
  const [status, body] = await run(client, 'get', '/json/version');
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).webSocketDebuggerUrl, endpoint);
  assert.deepEqual(JSON.parse((await run(client, 'get', '/json/list'))[1]), []);
  assert.match((await run(client, 'ws', [request()], {}, '?runtime=other')).refused, /404/);
  assert.deepEqual(fixture.seen, []);
  await client.close();
  await assert.rejects(kernel.connect({ tag }), /lease unavailable/);
});

test('validated lease calls, projected replies and safe errors cross the real job socket', async (t) => {
  const { jkt, lease, seen, adapter } = await fixtureAdapter();
  const client = await job(t, await setup(t, { tag, adapter }));
  const valid = [
    request(),
    request({ lease, allow: [{ kind: 'exact', url: 'https://billing.example/x' }] }),
    action(lease, 'goto', { url: allow[0].url }),
    action(lease, 'snapshot', {}),
    action(lease, 'click', { ref: 'e1' }),
    action(lease, 'fill', { ref: 'e1', value: 'test' }),
    action('another_job', 'snapshot', {}),
  ];
  const responses = await run(client, 'ws', valid, { tag: 'another-job' });
  const granted = { id: 1, result: { request: 'R1', lease, jkt } };
  const ack = { id: 2, result: { result: {} } };
  assert.deepEqual(responses.slice(0, -1), [
    granted,
    granted,
    ack,
    { id: 2, result: { result: { text: 'fixture document' } } },
    ack,
    ack,
  ]);
  assert.equal(responses.at(-1).error.data.reason, 'E_REVOKED');
  assert.ok(
    seen.every(({ stamp }) => stamp.tag === tag && stamp.tags.join(',') === `${tag},another-job`)
  );
  assert.doesNotMatch(JSON.stringify(responses), /must-not-echo/);
  const malformed = [
    '{',
    { ...request(), sessionId: 'a' },
    { ...request(), method: 'Target.getTargets' },
    { ...request(), method: 'Runtime.evaluate' },
    request({ allow }),
    request({ ...params, lease }),
    request({ ...params, allow: [...allow, ...allow] }),
    request({ allow: [{ kind: 'origin', url: 'https://billing.example/narrow' }], ttlSeconds: 1 }),
    request({
      allow: [{ kind: 'path-prefix', url: 'https://billing.example/a%2Fb' }],
      ttlSeconds: 1,
    }),
    request({ ...params, tag }),
    action(lease, 'click', { x: 1, y: 2 }),
    action(lease, 'snapshot', { expression: 'test' }),
    action(lease, 'goto', { url: 'file:///' }),
    action('a.b.c', 'fill', { ref: 'e1', value: 'test' }),
    action(lease, 'raw', {}),
  ];
  const invalid = await run(client, 'ws', malformed);
  assert.equal(invalid.length, malformed.length);
  assert.ok(invalid.every((r) => r.error?.data.reason === 'E_UNSUPPORTED'));
  assert.equal(seen.length, valid.length);
});

test('a lease job cannot execute JS, WASI imports or a package driver', async (t) => {
  const { adapter } = await fixtureAdapter();
  const kernel = await setup(t, { tag, adapter });
  const client = await job(t, kernel);
  await kernel.writeFile('/node_modules/extra/guest.js', "throw new Error('should not execute')");
  const commands = {
    script: { abi: 'js', module: 'guest.js' },
    imports: { abi: 'wasi', wasm: 'probe.wasm', imports: 'guest.js' },
    glue: { abi: 'emscripten', glue: 'guest.js', wasm: 'probe.wasm' },
  };
  await kernel.writeFile(
    '/node_modules/extra/package.json',
    JSON.stringify({ name: 'extra', slicc: { commands } })
  );
  await kernel.writeFile(
    '/node_modules/extra/probe.wasm',
    await kernel.readFile('/node_modules/leaseprobe/probe.wasm')
  );
  for (const name of Object.keys(commands))
    await assert.rejects(client.run([name], { cwd: '/' }), /without JavaScript imports/);
  await assert.rejects(
    client.mount({ type: 'tmpfs', source: 'tmpfs', target: '/tmp', options: {} }),
    /cannot mount host services/
  );
});

test('tearing down a job aborts an in-flight adapter action without returning its delayed output', async (t) => {
  const { adapter, lease } = await fixtureAdapter();
  const started = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  adapter.action = (_params, { signal }) => {
    started.resolve(signal);
    return delayed.promise;
  };
  const kernel = await setup(t, { tag, adapter });
  const client = await job(t, kernel);
  const result = client
    .run(['leaseprobe', 'ws', '', JSON.stringify(action(lease, 'snapshot', {}))], { cwd: '/' })
    .catch(() => null);
  const signal = await started.promise;
  const aborted = new Promise((resolve) =>
    signal.addEventListener('abort', resolve, { once: true })
  );
  await client.close();
  await aborted;
  delayed.resolve({ result: { text: 'must-not-release' } });
  assert.doesNotMatch(JSON.stringify(await result), /must-not-release/);
});

test('unacknowledged site actions return a safe unknown outcome without replay', async (t) => {
  const { adapter, lease } = await fixtureAdapter();
  let calls = 0;
  adapter.action = () => {
    if (++calls === 1) throw new Error('private transport error');
    return Promise.resolve({ result: { token: 'private transport value' } });
  };
  const client = await job(t, await setup(t, { tag, adapter }));
  const click = action(lease, 'click', { ref: 'e5' });
  const replies = await run(client, 'ws', [click, click]);
  assert.deepEqual(
    replies.map((r) => r.error.data.reason),
    ['E_OUTCOME_UNKNOWN', 'E_OUTCOME_UNKNOWN']
  );
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(replies), /private transport/);
});

test('a normal kernel does not serve a lease URL; a lease kernel refuses mixed host services', async (t) => {
  const kernel = await setup(t);
  const [lease, raw] = await run(kernel, 'env');
  assert.equal(lease, null);
  const endpoint = raw.replace('/devtools/browser/', '/slicc/lease/v1/');
  assert.match(
    (await run(kernel, 'ws', [request()], { env: { SLICC_CDP_LEASE_URL: endpoint } })).refused,
    /404/
  );
  const { adapter } = await fixtureAdapter();
  for (const mixed of [
    { cdp: () => {} },
    { network: { uplink: {} } },
    { network: { transport: {} } },
    { facades: {} },
    { requests: {} },
    { sealed: {} },
    { devices: {} },
    { clipboard: {} },
    { processMounts: true },
  ]) {
    await assert.rejects(createNodeKernel({ cdpLease: { tag, adapter }, ...mixed }), /lease-only/);
  }
  for (const invalid of [null, {}, { tag, adapter: {} }, { tag: '', adapter }])
    await assert.rejects(createNodeKernel({ cdpLease: invalid }), /cdpLease/);
});
