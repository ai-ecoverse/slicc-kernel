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

const HOLD = [
  'import fcntl, os, time',
  "f = open('db', 'r+b')",
  'fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  "open('r', 'w').close()",
  "while not os.path.exists('g'):",
  '    time.sleep(0.05)',
].join('\n');

const TRY = [
  'import errno, fcntl, os, time',
  "while not os.path.exists('r2'):",
  '    time.sleep(0.05)',
  "f = open('db', 'r+b')",
  'try:',
  '    fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  "    print('python got it', flush=True)",
  'except OSError as e:',
  "    print('python blocked', errno.errorcode[e.errno], flush=True)",
  "open('g2', 'w').close()",
  'fcntl.lockf(f, fcntl.LOCK_EX)',
  "print('python waited', flush=True)",
].join('\n');

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-sqlite3', 'wasix-python']) {
    await install(kernel, name);
  }
  await kernel.writeFile('/tmp/hold.py', HOLD);
  await kernel.writeFile('/tmp/try.py', TRY);
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp' });
}

test('a python lockf write lock keeps the sqlite3 CLI from writing, and a sqlite3 transaction keeps python’s lockf out (#722)', async (t) => {
  const bash = await booted(t);
  const held = await bash(
    `sqlite3 db "create table t(x)"; python3 hold.py & while [ ! -e r ]; do sleep 0.05; done; sqlite3 db "insert into t values(1)"; echo "rc=$?"; touch g; wait; sqlite3 db "insert into t values(2)"; sqlite3 db "select group_concat(x) from t"`
  );
  assert.match(held.stderr, /database is locked/);
  assert.equal(held.stdout, 'rc=1\n2\n');
  const blocked = await bash(
    `rm -f db r2 g2; sqlite3 db "create table t(x)"; (echo "begin immediate;"; echo "insert into t values(1);"; echo ".output r2"; echo "select 1;"; while [ ! -e g2 ]; do sleep 0.05; done; sleep 0.3; echo ".output stdout"; echo "commit;") | sqlite3 db & python3 try.py; wait; sqlite3 db "select group_concat(x) from t"`
  );
  assert.equal(blocked.stderr, '');
  assert.equal(blocked.stdout, 'python blocked EAGAIN\npython waited\n1\n');
});
