import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

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

test('a terminating signal sent to one thread of a WASIX program ends the whole process by that signal', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasix-python');
  const program = [
    'import signal, threading, time',
    't = threading.Thread(target=time.sleep, args=(30,), daemon=True)',
    't.start()',
    'print("started", flush=True)',
    'signal.pthread_kill(t.ident, signal.SIGTERM)',
    'time.sleep(30)',
    'print("still here")',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', 'python3 -c "$0"; echo "rc $?"', program], {
    cwd: '/',
  });
  assert.equal(r.stdout, 'started\nrc 143\n');
  assert.match(r.stderr, /Terminated/);
});

async function sigthread(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  const fixture = new URL('fixtures/sigthread/', import.meta.url);
  for (const file of ['package.json', 'bin/sigthread.wasm']) {
    await kernel.writeFile(
      `/node_modules/sigthread/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  return kernel;
}

test('a process-directed signal that the main thread blocks goes to a thread that does not, as on Linux (#520)', async (t) => {
  const kernel = await sigthread(t);
  assert.deepEqual(await kernel.run(['sigthread', 'handler'], { cwd: '/' }), {
    status: 0,
    stdout: "SIGUSR1 handled on the thread that doesn't block it\n",
    stderr: '',
  });
});

test('a terminating signal that the main thread blocks, but another thread does not, ends the process at once (#520)', async (t) => {
  const kernel = await sigthread(t);
  assert.deepEqual(await kernel.run(['sigthread', 'default'], { cwd: '/' }), {
    status: 143,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
  });
});
