import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../../dist/node.js';
import { installFixture, installPackage, shown, skip } from './async-wasi-harness.mjs';
import { dnsAnswer } from './cloudflare-fixture/dns-answer.js';

const DOH = 'https://dns.example/q';

function dohTransport(asked) {
  return {
    traits: { manualRedirects: true, encodedBodies: true, maxRequestBody: 1 << 20 },
    async fetch(req) {
      asked.push(`${req.method} ${req.url}`);
      return {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/dns-message']],
        body: (async function* () {
          yield dnsAnswer(req.body);
        })(),
        cancel: async () => {},
      };
    },
  };
}

async function pair(t, setup) {
  const asked = { sync: [], async: [] };
  const sync = await createNodeKernel({
    network: { transport: dohTransport(asked.sync), doh: DOH },
  });
  const async = await createNodeKernel({
    blocking: 'async',
    emscripten: 'kernel',
    network: { transport: dohTransport(asked.async), doh: DOH },
  });
  t.after(() => {
    sync.terminate();
    async.terminate();
  });
  await Promise.all([setup(sync), setup(async)]);
  const same = async (argv, normal = (r) => r) => {
    const want = normal(shown(await sync.run(argv, { cwd: '/' })));
    const got = normal(shown(await async.run(argv, { cwd: '/' })));
    assert.deepEqual(got, want, argv.join(' '));
    return got;
  };
  return { same, asked };
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

test("BIND's dig, host and nslookup start their threads on the async host and answer through the DoH forwarder", {
  skip,
  timeout: 120_000,
}, async (t) => {
  const { same, asked } = await pair(t, (kernel) => installPackage(kernel, 'wasix-bind'));
  assert.deepEqual(await same(['dig', '+short', 'example.com']), ok('93.184.215.14\n'));
  assert.deepEqual(
    await same(['host', 'example.com']),
    ok(
      'example.com has address 93.184.215.14\nexample.com has IPv6 address 2606:2800:21f:cb07:6820:80da:af6b:8b2c\nexample.com mail is handled by 10 mail.example.com.\n'
    )
  );
  const looked = await same(['nslookup', 'example.com']);
  assert.equal(looked.status, 0);
  assert.match(looked.stdout, /^Server:\t\t127\.0\.0\.53\nAddress:\t127\.0\.0\.53#53\n/);
  assert.match(looked.stdout, /Name:\texample\.com\nAddress: 93\.184\.215\.14\n/);
  assert.deepEqual(
    await same(['dig', '+short', '+tcp', 'example.com', 'AAAA']),
    ok('2606:2800:21f:cb07:6820:80da:af6b:8b2c\n')
  );
  const big = await same(['dig', '+short', '+noedns', 'big.example.com', 'TXT']);
  assert.equal(big.status, 0);
  assert.equal(big.stdout.split('\n').filter(Boolean).length, 12);
  const unstamped = (r) => ({
    ...r,
    stdout: r.stdout
      .replace(/id: \d+/g, 'id: ID')
      .replace(/^;; (Query time|WHEN|MSG SIZE).*\n/gm, ''),
  });
  const truncated = await same(['dig', '+noedns', 'big.example.com', 'TXT'], unstamped);
  assert.match(truncated.stdout, /;; Truncated, retrying in TCP mode\.\n/);
  assert.match(truncated.stdout, /;; SERVER: 127\.0\.0\.53#53\(127\.0\.0\.53\) \(TCP\)/);
  const missing = await same(['host', 'nope.example.org']);
  assert.equal(missing.status, 1);
  assert.ok(asked.async.length > 0);
  assert.deepEqual(new Set(asked.async), new Set([`POST ${DOH}`]));
});

const py = (code) => ['python', '-c', code];

test('WASIX threads run on the async host as on the sync kernel: join, a timed wait woken by another thread, contention, signals', {
  skip,
  timeout: 120_000,
}, async (t) => {
  const { same } = await pair(t, async (kernel) => {
    await installPackage(kernel, 'wasix-python');
    for (const name of ['epolltest', 'pipetest', 'sigthread', 'threadjmp']) {
      await installFixture(kernel, name);
    }
  });
  assert.deepEqual(
    await same(
      py(
        'import threading\nr = []\nts = [threading.Thread(target=r.append, args=(i,)) for i in range(8)]\nfor t in ts: t.start()\nfor t in ts: t.join()\nprint(sorted(r))'
      )
    ),
    ok('[0, 1, 2, 3, 4, 5, 6, 7]\n')
  );
  assert.deepEqual(
    await same(
      py(
        'import threading, time\ne = threading.Event()\nthreading.Timer(0.2, e.set).start()\nt = time.monotonic()\nprint(e.wait(20), time.monotonic() - t < 10)'
      )
    ),
    ok('True True\n')
  );
  assert.deepEqual(
    await same(
      py(
        'import threading\nc = threading.Condition()\nn = [0]\ndef w():\n  for i in range(200):\n    with c:\n      n[0] += 1\n      c.notify_all()\nts = [threading.Thread(target=w) for i in range(4)]\nfor t in ts: t.start()\nwith c:\n  c.wait_for(lambda: n[0] == 800, 20)\nfor t in ts: t.join()\nprint(n[0])'
      )
    ),
    ok('800\n')
  );
  assert.deepEqual(
    await same(
      py(
        'import queue, threading\nq = queue.Queue()\ndef p():\n  for i in range(100): q.put(i)\n  q.put(None)\nthreading.Thread(target=p).start()\ns = 0\nwhile (x := q.get()) is not None: s += x\nprint(s)'
      )
    ),
    ok('4950\n')
  );
  assert.deepEqual(await same(['epolltest', 'cross-thread']), ok('woken by thread: 1 13=IN\n'));
  assert.equal((await same(['pipetest', 'thread'])).status, 0);
  assert.deepEqual(
    await same(['sigthread', 'handler']),
    ok("SIGUSR1 handled on the thread that doesn't block it\n")
  );
  assert.equal((await same(['sigthread', 'default'])).status, 143);
  assert.equal((await same(['threadjmp'])).status, 0);
});
