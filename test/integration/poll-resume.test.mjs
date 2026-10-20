import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/sleeploop/', import.meta.url);

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

const ROUNDS = 40;

test("a plain wasip1 program's std::thread::sleep loop never fails while non-terminating signals and stop/continue arrive, and keeps its time (#1291, homescoop#1255)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  for (const file of ['package.json', 'bin/sleeploop.wasm']) {
    await kernel.writeFile(
      `/node_modules/sleeploop/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  const r = await kernel.run(
    [
      'bash',
      '-c',
      `rm -f /tmp/sleeploop.ready; sleeploop ${ROUNDS} & while [ ! -s /tmp/sleeploop.ready ]; do :; done; p=$(cat /tmp/sleeploop.ready); for i in 1 2 3 4 5; do kill -CHLD $p; kill -WINCH $p; kill -URG $p; kill -STOP $p; kill -CONT $p; done; wait $p; echo rc=$?`,
    ],
    { cwd: '/' }
  );
  assert.equal(r.stderr, '');
  const [slept, rc] = r.stdout.trim().split('\n');
  assert.equal(rc, 'rc=0', r.stdout);
  const ms = Number(/in (\d+) ms/.exec(slept)?.[1]);
  assert.ok(ms >= ROUNDS * 25 && ms < ROUNDS * 25 + 4000, slept);
});

const eintr = new URL('./fixtures/eintrsleep/', import.meta.url);

test('a WASIX program whose handler catches a signal still sees nanosleep end early with EINTR, while an ignored signal leaves it asleep (#1291)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  for (const file of ['package.json', 'bin/eintrsleep.wasm']) {
    await kernel.writeFile(
      `/node_modules/eintrsleep/${file}`,
      await readFile(new URL(file, eintr))
    );
  }
  const r = await kernel.run(
    [
      'bash',
      '-c',
      'rm -f /tmp/eintrsleep.ready; eintrsleep & while [ ! -s /tmp/eintrsleep.ready ]; do :; done; p=$(cat /tmp/eintrsleep.ready); kill -CHLD $p; kill -WINCH $p; kill -USR1 $p; wait $p',
    ],
    { cwd: '/' }
  );
  assert.deepEqual(r, {
    status: 0,
    stdout: 'nanosleep rc=-1 Interrupted system call hits=1 early=1\n',
    stderr: '',
  });
});
