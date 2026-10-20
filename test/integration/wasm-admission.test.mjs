import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import * as testing from '../../dist/testing.js';

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

test('a spawn beyond the wasm-memory ceiling waits while the processes ahead of it are still starting, and gets in when one ends, instead of EAGAIN (#1196, #970)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({
    users: 'off',
    wasmMemories: { ceiling: 2, idleMs: 1500 },
  });
  t.after(() => kernel.terminate());
  t.after(() => testing.setTestSyscallHook(undefined));
  await install(kernel, 'wasm-coreutils');
  assert.equal((await kernel.run(['sleep', '0'], { cwd: '/' })).status, 0);
  const holds = [1000, 2000];
  const held = new Map();
  testing.setTestSyscallHook(async ({ pid }) => {
    if (!held.has(pid)) held.set(pid, holds.length > 0 ? holds.shift() : 0);
    const ms = held.get(pid);
    if (ms > 0) {
      held.set(pid, 0);
      await new Promise((r) => setTimeout(r, ms));
    }
  });
  const started = Date.now();
  const runs = await Promise.all(
    [0, 1, 2].map((i) =>
      new Promise((r) => setTimeout(r, i * 50))
        .then(() => kernel.run(['sleep', '1'], { cwd: '/' }))
        .then(
          (r) => r.status,
          (e) => e.code ?? String(e)
        )
    )
  );
  assert.deepEqual(runs, [0, 0, 0], `after ${Date.now() - started} ms`);
});
