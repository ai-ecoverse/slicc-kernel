import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { processTree, progressing } from './progress.mjs';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function kernelWith(t) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  return { kernel, bash, sample: processTree(bash) };
}

test('the progress watchdog fails a process tree that stops making progress after its quiet window, not at the outer bound, and says where it was', {
  timeout: 120_000,
}, async (t) => {
  const { bash, sample } = await kernelWith(t);
  const started = Date.now();
  await assert.rejects(
    progressing(bash('sleep 100000'), {
      sample,
      quietMs: 6_000,
      everyMs: 1_000,
      maxMs: 100_000,
      label: 'sleep',
    }),
    (err) => {
      const quiet = Number(
        err.message.match(/^sleep: no progress for (\d+) s after \d+ s; processes:\n/)?.[1]
      );
      assert.ok(quiet >= 6 && quiet < 20, err.message);
      assert.match(err.message, /\d+ sleep S cpu [\d.]+ s/);
      return true;
    }
  );
  const took = Date.now() - started;
  assert.ok(took < 40_000, `the watchdog took ${took} ms`);
});

test('the progress watchdog lets a slow tree that keeps using CPU run past its quiet window', {
  timeout: 120_000,
}, async (t) => {
  const { bash, sample } = await kernelWith(t);
  const busy = 'end=$((SECONDS + 10)); while [ $SECONDS -lt $end ]; do :; done; echo done';
  const r = await progressing(bash(busy), {
    sample,
    quietMs: 4_000,
    everyMs: 1_000,
    label: 'busy',
  });
  assert.deepEqual(r, { status: 0, stdout: 'done\n', stderr: '' });
});
