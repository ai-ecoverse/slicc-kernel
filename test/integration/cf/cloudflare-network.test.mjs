import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
const PACKAGES = ['wasm-bash', 'wasm-coreutils', 'wasm-curl', 'wasm-jq'];
let dev;
let processHost;
let call;
let run;

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
  for (const name of PACKAGES) {
    await uploadTree(call, join(MODULES, name), `/node_modules/@ai-ecoverse/${name}`, programs);
  }
  run = async (script) => {
    const r = await call('/kernel/run', { argv: ['bash', '-c', script] });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built yet (workstream B2)';
  if (why) t.skip(why);
  return Boolean(why);
};

describe('programs reach the network from a Durable Object', { concurrency: false }, () => {
  test('curl speaks https through the kernel proxy, with a TLS engine the Worker compiled', async (t) => {
    if (skipped(t)) return;
    const first = await run('curl -sS https://example.test/a?b=1 -H "x-test: yes"');
    assert.deepEqual(first, {
      status: 0,
      stdout: 'GET https://example.test/a?b=1 yes \n',
      stderr: '',
    });
    const verified = await run(
      'curl -sS -o /dev/null -w "%{http_code} %{ssl_verify_result} %{scheme}\\n" https://example.test/teapot'
    );
    assert.deepEqual(verified, { status: 0, stdout: '418 0 https\n', stderr: '' });
    const posted = await run(
      'curl -sS -i -X POST -d k=v https://other.test:8443/p | tr -d "\\r" | while read l; do case "$l" in HTTP*|x-served*|POST*) echo "$l";; esac; done'
    );
    assert.deepEqual(posted, {
      status: 0,
      stdout:
        'HTTP/1.1 200 Connection Established\nHTTP/1.1 200 OK\nx-served: fixture\nPOST https://other.test:8443/p null k=v\n',
      stderr: '',
    });
    const plain = await run('curl -sS http://example.test/plain');
    assert.equal(plain.stdout, 'GET http://example.test/plain null \n');
    assert.deepEqual((await call('/kernel/fetched', {})).fetched, [
      'GET https://example.test/a?b=1',
      'GET https://example.test/teapot',
      'POST https://other.test:8443/p',
      'GET http://example.test/plain',
    ]);
  });

  test('loading the engine leaves WebAssembly.instantiate as it was', async (t) => {
    if (skipped(t)) return;
    const empty = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const tagged = [...new TextEncoder().encode('slicc-tls'), 0, 0, 0, 1];
    const module = await call('/kernel/instantiate', { bytes: empty });
    assert.equal(module.patched, 'instantiate');
    assert.match(String(module.made), /disallowed|instance,module/);
    const ticket = await call('/kernel/instantiate', { bytes: tagged });
    assert.equal(typeof ticket.made, 'string');
    assert.doesNotMatch(ticket.made, /instance/);
  });

  test('jq, linked with pthreads, runs on one thread', async (t) => {
    if (skipped(t)) return;
    const r = await run(
      'echo "{\\"a\\":[1,2,3]}" | jq -c ".a|map(.*2)"; jq -n "\\"2015-03-05T23:51:47Z\\"|strptime(\\"%Y-%m-%dT%H:%M:%SZ\\")|mktime"; jq -n "[range(200000)]|length"; echo "[1" | jq . 2>&1; echo rc=$?'
    );
    assert.deepEqual(r, {
      status: 0,
      stdout:
        '[2,4,6]\n1425599507\n200000\njq: parse error: Unfinished JSON term at EOF at line 2, column 0\nrc=5\n',
      stderr: '',
    });
  });
});
