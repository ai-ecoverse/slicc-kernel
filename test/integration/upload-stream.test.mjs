import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const SINK = 'http://upload-sink.test/';
const DEADLINE_MS = 30_000;

const within = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} within ${DEADLINE_MS} ms`)), DEADLINE_MS).unref()
    ),
  ]);

test("curl -T streams a body over maxRequestBody to the page's transport, across the worker", async (t) => {
  const { bash } = await booted(chrome, t, { uploadSink: 64 * 1024 });

  const made = await bash(
    'head -c 1048576 /dev/urandom > /tmp/big.bin && sha256sum /tmp/big.bin | cut -d" " -f1'
  );
  assert.equal(made.status, 0);
  const { status, stdout } = await bash(`curl -sS -T /tmp/big.bin ${SINK}`);
  assert.equal(status, 0);
  assert.equal(stdout, `stream 1048576 ${made.stdout.trim()}`);
});

test("a chunked upload reaches the page's transport before the program has written all of it", async (t) => {
  const { page, bash } = await booted(chrome, t, { uploadSink: 64 * 1024 });

  const running = bash(
    `{ printf 'first '; until [ -e /tmp/go ]; do sleep 0.02; done; printf second; } | curl -sS -T - ${SINK}`
  );
  running.catch(() => undefined);
  assert.equal(
    await within(
      page.evaluate(() => window.firstPart),
      'the first part'
    ),
    'first '
  );
  assert.equal((await bash('touch /tmp/go')).status, 0);
  const { status, stdout } = await running;
  assert.equal(status, 0);
  assert.match(stdout, /^stream 12 [0-9a-f]{64}$/);
});
