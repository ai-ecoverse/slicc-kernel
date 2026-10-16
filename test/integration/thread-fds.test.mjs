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
  'import os, threading',
  'def on_thread(fn):',
  '    t = threading.Thread(target=fn)',
  '    t.start(); t.join()',
  "for name in 'abc':",
  "    with open(f'/tmp/{name}', 'w') as f: f.write(name.upper())",
  "fd = os.open('/tmp/a', os.O_RDONLY)",
  'seen = [os.pread(fd, 1, 0)]',
  'def reopen():',
  '    os.close(fd)',
  "    assert os.open('/tmp/b', os.O_RDONLY) == fd",
  'on_thread(reopen)',
  'seen.append(os.pread(fd, 1, 0))',
  "on_thread(lambda: os.dup2(os.open('/tmp/c', os.O_RDONLY), fd))",
  'seen.append(os.pread(fd, 1, 0))',
  'seen.append(os.get_inheritable(fd))',
  'on_thread(lambda: os.set_inheritable(fd, False))',
  'seen.append(os.get_inheritable(fd))',
  'r, w = os.pipe()',
  "on_thread(lambda: (os.close(r), os.close(w), os.dup2(os.open('/tmp/a', os.O_RDONLY), r)))",
  'seen.append(os.pread(r, 1, 0))',
  'def churn():',
  '    for _ in range(100):',
  "        os.close(os.open('/tmp/a', os.O_RDONLY))",
  "    os.dup2(os.open('/tmp/b', os.O_RDONLY), fd)",
  'on_thread(churn)',
  'seen.append(os.pread(fd, 1, 0))',
  'print(*seen)',
].join('\n');

test('a thread that closes, reopens, dup2s or changes an fd is seen by the main thread at once, also after a burst of other opens (#774)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile('/tmp/fds.py', PY);
  const r = await kernel.run(['python3', '/tmp/fds.py'], { cwd: '/tmp' });
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, "b'A' b'B' b'C' True False b'A' b'B'\n");
});
