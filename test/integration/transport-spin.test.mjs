import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('./fixtures/spintest/', import.meta.url);
async function kernelWith(t) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/spintest.wasm', 'bin/spinread.mjs']) {
    await kernel.writeFile(
      `/node_modules/spintest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  return kernel;
}

const cpuSeconds = (from) => {
  const used = process.cpuUsage(from);
  return (used.user + used.system) / 1e6;
};

test('fast replies: 1-byte pipe rounds arrive in order, in one process and in four at once (#864)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await kernelWith(t);
  const ok = { status: 0, stdout: '20000 rounds in order\n', stderr: '' };
  assert.deepEqual(await kernel.run(['spintest', 'rounds', '20000'], { cwd: '/' }), ok);
  const four = await Promise.all(
    Array.from({ length: 4 }, () => kernel.run(['spintest', 'rounds', '20000'], { cwd: '/' }))
  );
  assert.deepEqual(four, [ok, ok, ok, ok]);
});

test('a slow reply: a process blocked in the kernel uses next to no CPU while it waits, then completes (#864)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await kernelWith(t);
  const term = await kernel.openTerminal(['spintest', 'wait'], { cwd: '/' });
  let out = '';
  let blocked;
  const ready = new Promise((resolve) => (blocked = resolve));
  term.onData = (bytes) => {
    out += new TextDecoder().decode(bytes);
    if (out.includes('waiting')) blocked();
  };
  await ready;
  await sleep(500);
  const from = process.cpuUsage();
  const started = performance.now();
  await sleep(2000);
  const used = cpuSeconds(from);
  const wall = (performance.now() - started) / 1000;
  term.write('x\r');
  assert.equal(await term.exited, 0, out);
  assert.match(out, /read 1 byte: x/);
  assert.ok(
    used < 0.25 * wall,
    `${used.toFixed(2)} s of CPU in ${wall.toFixed(2)} s of a blocked wait`
  );
});

test('a reply that fills the transport window and one larger than it arrive whole: 1 MiB WASI reads and a 3 MiB file a JS program reads (#864)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await kernelWith(t);
  assert.deepEqual(await kernel.run(['spintest', 'big', '3'], { cwd: '/' }), {
    status: 0,
    stdout: '3 reads of 1 MiB, each whole\n',
    stderr: '',
  });
  const big = new Uint8Array(3 * 1024 * 1024 + 12345).map((_, i) => (i * 7 + 1) & 0xff);
  await kernel.writeFile('/tmp/big.bin', big);
  const sum = big.reduce((h, b) => (h * 31 + b) >>> 0, 0);
  assert.deepEqual(await kernel.run(['spinread', '/tmp/big.bin'], { cwd: '/' }), {
    status: 0,
    stdout: `${big.length} ${sum}\n`,
    stderr: '',
  });
});
