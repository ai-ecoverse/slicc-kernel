import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const together = (page, argv, n) =>
  page.run(
    { maxMs: 300_000 },
    (a, k) => Promise.all(Array.from({ length: k }, () => window.kernel.run(a, { cwd: '/tmp' }))),
    argv,
    n
  );

test('more live processes than V8 has room for wait their turn instead of failing with a RangeError (#970)', {
  timeout: 400_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t);
  const sleeps = await together(page, ['sleep', '2'], 150);
  assert.deepEqual(
    sleeps.filter((r) => r.status !== 0 || r.stderr !== ''),
    [],
    'every one of 150 concurrent sleeps exits 0'
  );
  const pipes = await together(
    page,
    ['bash', '-c', "head -c 60000 /dev/zero | tr '\\0' x | wc -c"],
    20
  );
  assert.deepEqual(
    pipes.map((r) => r.stdout),
    Array(20).fill('60000\n')
  );
  const shown = await bash('cat /proc/sys/kernel/slicc_wasm_memories');
  assert.match(shown.stdout, /^\d+ \d+ (default|learned)\n$/);
  assert.ok(Number(shown.stdout.split(' ')[1]) > 0, `a ceiling is known: ${shown.stdout}`);
});
