import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const DOH = 'https://cloudflare-dns.example/dns-query';
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
let dev;
let processHost;
let call;

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (dev.skip) return;
  call = client(dev);
  assert.equal((await call('/kernel/boot', { network: true, doh: DOH })).status, 200);
  await uploadTree(
    call,
    join(MODULES, 'wasix-bind'),
    '/node_modules/@ai-ecoverse/wasix-bind',
    programs
  );
  for (const name of ['epolltest', 'sigthread']) {
    await uploadTree(call, join(FIXTURES, name), `/node_modules/${name}`, programs);
  }
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built yet';
  if (why) t.skip(why);
  return Boolean(why);
};

const run = async (argv) => {
  const r = await call('/kernel/run', { argv });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

describe('threads in a Dynamic Worker', { concurrency: false }, () => {
  test("BIND's dig, host and nslookup answer through the kernel's stub and its DoH forwarder", async (t) => {
    if (skipped(t)) return;
    await call('/kernel/fetched', {});
    assert.deepEqual(await run(['dig', '+short', 'example.com']), ok('93.184.215.14\n'));
    assert.deepEqual(
      await run(['host', 'example.com']),
      ok(
        'example.com has address 93.184.215.14\nexample.com has IPv6 address 2606:2800:21f:cb07:6820:80da:af6b:8b2c\nexample.com mail is handled by 10 mail.example.com.\n'
      )
    );
    const looked = await run(['nslookup', 'example.com']);
    assert.equal(looked.status, 0, looked.stderr);
    assert.match(looked.stdout, /^Server:\t\t127\.0\.0\.53\nAddress:\t127\.0\.0\.53#53\n/);
    assert.match(looked.stdout, /Name:\texample\.com\nAddress: 93\.184\.215\.14\n/);
    const tcp = await run(['dig', '+noedns', 'big.example.com', 'TXT']);
    assert.equal(tcp.status, 0, tcp.stderr);
    assert.match(tcp.stdout, /;; Truncated, retrying in TCP mode\.\n/);
    assert.match(tcp.stdout, /;; SERVER: 127\.0\.0\.53#53\(127\.0\.0\.53\) \(TCP\)/);
    assert.equal((tcp.stdout.match(/\tTXT\t/g) ?? []).length, 12);
    const { fetched } = await call('/kernel/fetched', {});
    assert.ok(fetched.length >= 6, `${fetched.length} DoH requests`);
    assert.deepEqual(new Set(fetched), new Set([`POST ${DOH}`]));
  });

  test('a WASIX program wakes its epoll from a second thread, and a blocked signal goes to the thread that takes it', async (t) => {
    if (skipped(t)) return;
    assert.deepEqual(await run(['epolltest', 'cross-thread']), ok('woken by thread: 1 13=IN\n'));
    assert.deepEqual(
      await run(['sigthread', 'handler']),
      ok("SIGUSR1 handled on the thread that doesn't block it\n")
    );
    const stats = await call('/kernel/stats');
    assert.ok(stats.peak <= 2, `peak ${stats.peak} Dynamic Workers`);
  });
});
