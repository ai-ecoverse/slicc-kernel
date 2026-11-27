import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { attachKernel, CDP_LEASE_VERSION, createNodeKernel } from '../../dist/node.js';
import { fixtureAdapter } from './fixtures/lease-adapter.mjs';
import { cliFiles, exerciseCli } from './lease-cli.mjs';

test('the published playwright-cli WASI calls only the stamped read-only adapter', async (t) => {
  const fixture = await fixtureAdapter();
  const kernel = await setup(t, { tag, adapter: fixture.adapter });
  for (const [path, data] of await cliFiles()) await kernel.writeFile(path, data);
  const client = await job(t, kernel);
  await exerciseCli((argv) => client.run(argv, { cwd: '/' }), fixture);
  assert.deepEqual(
    fixture.seen.map(({ method, params }) => params.op ?? method),
    ['request', 'goto', 'snapshot', 'request']
  );
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

async function setup(t, cdpLease, options = {}) {
  const kernel = await createNodeKernel(cdpLease ? { cdpLease } : options);
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
  for (const [path, data] of await cliFiles()) await kernel.writeFile(path, data);
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
  assert.deepEqual(await run(kernel, 'env', '', { tag }), [null, null]);
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
  assert.match(
    (await run(kernel, 'ws', [request()], { tag, env: { SLICC_CDP_LEASE_URL: endpoint } })).refused,
    /403/
  );
  for (const path of [rawPath, '/json?runtime=other', '/json/version?runtime=other'])
    assert.equal((await run(client, 'get', path))[0], 404);
  const [status, body] = await run(client, 'get', '/json/version');
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).webSocketDebuggerUrl, endpoint);
  assert.deepEqual(JSON.parse((await run(client, 'get', '/json/list'))[1]), []);
  assert.match((await run(client, 'ws', [request()], {}, '?runtime=other')).refused, /404/);
  for (const env of [
    { SLICC_CDP_LEASE_URL: endpoint },
    { SLICC_CDP_LEASE_URL: `${endpoint}?runtime=other` },
  ]) {
    const result = await kernel.run(
      ['playwright-cli', 'lease', 'request', '--allow', 'https://billing.example', '--for', '1h'],
      { tag, cwd: '/', env }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).reason, 'E_UNAVAILABLE');
  }
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
    action(lease, 'click', { ref: 'e1' }),
    action(lease, 'fill', { ref: 'e1', value: 'test' }),
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

test('goto preserves mixed-case paths, query, underscores and brackets; controls never reach the adapter', async (t) => {
  const { adapter, lease, seen } = await fixtureAdapter();
  const client = await job(t, await setup(t, { tag, adapter }));
  const valid = ['https://Example.com/Path_a[1]?q=A', 'https://billing.example/invoices/@OLD'];
  const invalid = [
    'https://myself@billing.example/a',
    'https://@billing.example/a',
    'https://billing.example/a b',
    'https://billing.example/a\\b',
    ...[0, 1, 9, 31, 127].map((c) => 'https://billing.example/a' + String.fromCharCode(c) + 'b'),
  ];
  const replies = await run(
    client,
    'ws',
    [...valid, ...invalid].map((url) => action(lease, 'goto', { url }))
  );
  assert.ok(replies.slice(0, valid.length).every((r) => r.result));
  assert.ok(replies.slice(valid.length).every((r) => r.error?.data.reason === 'E_UNSUPPORTED'));
  assert.deepEqual(
    seen.map((e) => e.params.args.url),
    valid
  );
});

test('D2 candidate: kernel generic typed offer ingress, not pilot eligibility or document authority', async (t) => {
  const bytes = await readFile(new URL('./fixtures/lease-scope-v1.fixture', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '0fbec3e0add0af611c196a0ab5cb8918a933db243d7724cfe9df441889e01246'
  );
  const { exactInitialPilotCases: rows } = JSON.parse(bytes);
  const fixture = await fixtureAdapter();
  const client = await job(t, await setup(t, { tag, adapter: fixture.adapter }));
  let approved = 0,
    rejected = 0;
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    const proposals = batch.map((r) =>
      r.initial ? { allow: r.allow, ttlSeconds: 900 } : { lease: fixture.lease, allow: r.allow }
    );
    const replies = await run(client, 'ws', proposals.map(request));
    for (const [j, r] of batch.entries()) {
      const valid = r.consumerOverrides?.kernelRuleValid ?? r.contexts.general.ruleValid;
      if (valid) {
        assert.ok(replies[j].result, r.id);
        assert.deepEqual(fixture.seen[approved++].params, proposals[j], r.id);
      } else {
        assert.equal(replies[j].error?.data.reason, 'E_UNSUPPORTED', r.id);
        rejected++;
      }
    }
    assert.equal(fixture.seen.length, approved);
  }
  assert.deepEqual([approved, rejected], [169, 46]);
  t.diagnostic(
    `kernel rule ingress: ${approved} forwarded unchanged, ${rejected} refused before adapter; matcher/pilot/grant echo/owner review/final document not classified`
  );
});

test('128 KiB inclusive on wire in both directions; oversized input is never dispatched', async (t) => {
  const { adapter } = await fixtureAdapter();
  const limit = 128 * 1024;
  const empty = JSON.stringify({ id: 1, result: { result: { text: '' } } }).length;
  const text = 'é'.repeat(Math.floor((limit - empty) / 2)) + 'x'.repeat((limit - empty) % 2);
  let calls = 0;
  adapter.action = async () => ({ result: { text: ++calls === 1 ? text : text + 'x' } });
  const client = await job(t, await setup(t, { tag, adapter }));
  const [at] = await run(client, 'ws', [`pad:${limit}`]);
  assert.equal(Buffer.byteLength(JSON.stringify(at)), limit);
  assert.equal(at.result.result.text, text);
  const [over] = await run(client, 'ws', [`pad:${limit}`]);
  assert.equal(over.error.data.reason, 'E_UNSUPPORTED');
  assert.deepEqual(await run(client, 'ws', [`pad:${limit + 1}`]), [{ close: 1009 }]);
  assert.equal(calls, 2);
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
  const goto = action(lease, 'goto', { url: allow[0].url });
  const replies = await run(client, 'ws', [goto, goto]);
  assert.deepEqual(
    replies.map((r) => r.error.data.reason),
    ['E_OUTCOME_UNKNOWN', 'E_OUTCOME_UNKNOWN']
  );
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(replies), /private transport/);
});

test('a normal kernel does not serve a lease URL; a lease kernel refuses mixed host services', async (t) => {
  const ledger = [];
  const kernel = await setup(t, undefined, {
    cdp: async () => {
      ledger.push('open');
      const conn = {
        onmessage: null,
        onclose: null,
        close() {},
        send(text) {
          const { id, method } = JSON.parse(text);
          ledger.push(method);
          conn.onmessage(JSON.stringify({ id, result: { targetInfos: [] } }));
        },
      };
      return conn;
    },
  });
  for (const [path, data] of await cliFiles()) await kernel.writeFile(path, data);
  const [lease, raw] = await run(kernel, 'env');
  assert.equal(lease, null);
  const endpoint = raw.replace('/devtools/browser/', '/slicc/lease/v1/');
  assert.match(
    (await run(kernel, 'ws', [request()], { env: { SLICC_CDP_LEASE_URL: endpoint } })).refused,
    /404/
  );
  for (const selector of [undefined, '', `${endpoint}?runtime=other`, raw, endpoint]) {
    const env = selector === undefined ? {} : { SLICC_CDP_LEASE_URL: selector };
    const result = await kernel.run(
      ['playwright-cli', 'lease', 'request', '--allow', 'https://billing.example', '--for', '1h'],
      { cwd: '/', env }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).reason, 'E_UNAVAILABLE');
    assert.deepEqual(ledger, []);
  }
  assert.equal((await run(kernel, 'get', '/json/list'))[0], 200);
  assert.deepEqual(ledger, ['open', 'Target.getTargets']);
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
    { worker: 'untrusted.js' },
    { driverWorker: 'untrusted.js' },
    { asyncProcess: {} },
    { root: {} },
    { commands: { append: ['/other'] } },
    { modules: '/other' },
    { ports: [] },
    { mounts: [] },
    { fstab: [] },
    { hostfsFetch: () => {} },
    { onDenial: () => {} },
    { protect: {} },
    { durable: () => {} },
    { clock: () => {} },
    { processHost: {} },
    { network: { tlsEngine: () => {} } },
    { cron: {} },
    ...[
      'meta',
      'ranged',
      'hostfs',
      'hostfsOrigin',
      'approve',
      'fstabRetries',
      'requestDirectory',
      'onMountPending',
      'loader',
      'env',
      'metadata',
      'media',
      'ca',
      'timeZone',
      'hostname',
      'users',
      'sudo',
      'compileCache',
      'warmWorker',
      'warmWorkers',
      'wasmMemories',
      'emscripten',
      'blocking',
      'isolates',
      'sqlite',
      'sql',
      'unknown',
    ].map((k) => ({ [k]: true })),
  ]) {
    await assert.rejects(
      createNodeKernel({ cdpLease: { tag, adapter }, ...mixed }),
      /lease-only/,
      Object.keys(mixed).join(',')
    );
  }
  for (const invalid of [null, {}, { tag, adapter: {} }, { tag: '', adapter }])
    await assert.rejects(createNodeKernel({ cdpLease: invalid }), /cdpLease/);
});
