import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

const PY = [
  'import os, subprocess, threading',
  'warm = threading.Thread(target=lambda: None)',
  'warm.start(); warm.join()',
  "f = open('/tmp/w.txt', 'w')",
  "f.write('hello'); f.flush()",
  'seen = []',
  "t = threading.Thread(target=lambda: seen.append(os.stat('/tmp/w.txt').st_size))",
  't.start(); t.join()',
  "print('thread', seen[0], os.path.getsize('/tmp/w.txt'), flush=True)",
  "subprocess.run(['stat', '-c', 'process %s', '/tmp/w.txt'])",
  "subprocess.run(['cat', '/tmp/w.txt']); print(flush=True)",
  "f.write(' world'); f.flush()",
  "subprocess.run(['stat', '-c', 'process %s', '/tmp/w.txt'])",
  "subprocess.run(['bash', '-c', 'ls -l /tmp/w.txt | cut -d \" \" -f5'])",
  "print('again', os.stat('/tmp/w.txt').st_size, flush=True)",
].join('\n');

test('a threaded writer’s unflushed write is seen by a path stat, lstat and ls -l in another thread and another process (#774, #780)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const r = await kernel.run(['python3', '-c', PY], { cwd: '/tmp' });
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'thread 5 5\nprocess 5\nhello\nprocess 11\n11\nagain 11\n');
});
