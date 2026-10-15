import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name, as = name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${as}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

async function booted(t, coreutils, options = {}) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, coreutils, 'wasm-coreutils');
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
}

test('uname answers from the kernel: Linux, the hostname, /proc release and version, wasm32', async (t) => {
  const bash = await booted(t, 'wasm-coreutils');
  const r = await bash(
    'uname -r; cat /proc/sys/kernel/osrelease; uname -s -m; uname -n; uname -v; uname -snrvm'
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      '6.0.0-slicc',
      '6.0.0-slicc',
      'Linux wasm32',
      'slicc',
      '#1 SMP PREEMPT_DYNAMIC',
      'Linux slicc 6.0.0-slicc #1 SMP PREEMPT_DYNAMIC wasm32',
      '',
    ].join('\n')
  );
  const proc = await bash('cat /proc/version');
  assert.match(proc.stdout, /^Linux version 6\.0\.0-slicc .*#1 SMP PREEMPT_DYNAMIC\n$/);
});

test('uname -n is the node name the kernel was given', async (t) => {
  const bash = await booted(t, 'wasm-coreutils', { hostname: 'box1' });
  const r = await bash('uname -n; cat /etc/hostname');
  assert.equal(r.stdout, 'box1\nbox1\n', r.stderr);
});

test('a coreutils build without the uname import keeps the Emscripten answer', async (t) => {
  const bash = await booted(t, 'wasm-coreutils-pre-h1');
  const r = await bash('uname -s -r');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Emscripten 4.0.23\n');
});
