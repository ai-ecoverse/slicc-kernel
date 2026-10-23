import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name, skip) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    const rel = relative(fileURLToPath(base), file);
    if (skip?.test(rel)) continue;
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${rel}`, await readFile(file));
  }
}

const SCRIPT = [
  'import os, subprocess',
  "os.makedirs('/tmp/i/d', exist_ok=True)",
  "open('/tmp/i/f', 'w').write('old')",
  "fd = os.open('/tmp/i/f', os.O_RDONLY)",
  'a = os.fstat(fd).st_ino',
  "subprocess.run(['bash', '-c', 'rm /tmp/i/f && printf new > /tmp/i/f'], check=True)",
  "print('removed', a == os.fstat(fd).st_ino, os.stat('/tmp/i/f').st_ino != a, os.read(fd, 8).decode())",
  "open('/tmp/i/d/g', 'w').write('g')",
  "held = os.open('/tmp/i/d/g', os.O_RDONLY)",
  'b = os.fstat(held).st_ino',
  "os.rename('/tmp/i/d', '/tmp/i/e')",
  "print('renamed', b == os.stat('/tmp/i/e/g').st_ino, b == os.fstat(held).st_ino)",
  "os.makedirs('/tmp/i/m', exist_ok=True)",
  "made = os.open('/tmp/i/m/new', os.O_RDWR | os.O_CREAT)",
  'c = os.fstat(made).st_ino',
  "os.rename('/tmp/i/m', '/tmp/i/n')",
  "print('created', c == os.stat('/tmp/i/n/new').st_ino, c == os.fstat(made).st_ino)",
].join('\n');

test("an open file keeps its inode: removed and made again by another process, the new file is another inode; and its directory renamed, stat at the new name gives the descriptor's inode, for a file the open made too (#1454, #1163)", {
  timeout: 600_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  const r = await kernel.run(['python3', '-c', SCRIPT], { cwd: '/' });
  assert.deepEqual(
    [r.status, r.stdout, r.stderr],
    [0, 'removed True True old\nrenamed True True\ncreated True True\n', '']
  );
});
