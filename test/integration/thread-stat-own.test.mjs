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
  'warm = threading.Thread(target=lambda: None)',
  'warm.start(); warm.join()',
  "os.makedirs('/tmp/real/d')",
  "os.symlink('/tmp/real', '/tmp/sym')",
  'def seen(p):',
  '    try:',
  '        return os.stat(p).st_size',
  '    except FileNotFoundError:',
  "        return 'ENOENT'",
  "print('before', seen('/tmp/sym/d/f'), seen('/tmp/sym/d/n/g'), flush=True)",
  "open('/tmp/real/d/f', 'w').close()",
  "os.mkdir('/tmp/real/d/n')",
  "with open('/tmp/real/d/n/g', 'w') as g: g.write('abc')",
  "print('created', seen('/tmp/sym/d/f'), seen('/tmp/sym/d/n/g'), flush=True)",
  "print('mode', oct(os.stat('/tmp/sym/d/f').st_mode & 0o777), flush=True)",
  "os.chmod('/tmp/real/d/f', 0o600)",
  "print('chmod', oct(os.stat('/tmp/sym/d/f').st_mode & 0o777), flush=True)",
  "with open('/tmp/real/d/f', 'w') as f: f.write('hello')",
  "print('written', os.path.getsize('/tmp/sym/d/f'), os.lstat('/tmp/real/d/f').st_size, flush=True)",
  "os.utime('/tmp/real/d/f', (1000000000, 1000000000))",
  "print('utime', int(os.stat('/tmp/sym/d/f').st_mtime), flush=True)",
  "os.unlink('/tmp/real/d/f')",
  "print('removed', seen('/tmp/sym/d/f'), flush=True)",
].join('\n');

test('a threaded program sees its own creates, chmods, writes, times and removals at once through another path to the same file (#774)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile('/tmp/own.py', PY);
  const r = await kernel.run(['python3', '/tmp/own.py'], { cwd: '/tmp' });
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    'before ENOENT ENOENT\ncreated 0 3\nmode 0o644\nchmod 0o600\nwritten 5 5\nutime 1000000000\nremoved ENOENT\n'
  );
});
