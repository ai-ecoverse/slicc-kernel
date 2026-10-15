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

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python', 'wasm-sqlite3']) {
    await install(kernel, name);
  }
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp' });
}

const MARK = 'echo ".output ready"; echo "select 1;"; echo ".output stdout";';

test('an open sqlite connection sees another process commit, and keeps its row (#665)', async (t) => {
  const bash = await booted(t);
  const r = await bash(`
    sqlite3 v.db 'create table t(x); insert into t values(0);'
    ( echo "select 'A1', group_concat(x) from t;"; ${MARK}
      until [ -e go ]; do sleep 0.05; done
      echo "select 'A2', group_concat(x) from t;"; echo "insert into t values(7);" ) | sqlite3 v.db > a.out &
    until [ -e ready ]; do sleep 0.05; done
    sqlite3 v.db 'insert into t values(5);'
    touch go; wait
    cat a.out; sqlite3 v.db 'select group_concat(x) from t'`);
  assert.deepEqual(r, { status: 0, stdout: 'A1|0\nA2|0,5\n0,5,7\n', stderr: '' });
});

test('python sqlite3 sees a commit of the sqlite3 CLI while its connection is open (#665)', async (t) => {
  const bash = await booted(t);
  const py = [
    'import os, sqlite3, time',
    "c = sqlite3.connect('p.db')",
    "print('P1', c.execute('select group_concat(x) from t').fetchone()[0])",
    "open('ready', 'w').close()",
    "while not os.path.exists('go'): time.sleep(0.05)",
    "print('P2', c.execute('select group_concat(x) from t').fetchone()[0])",
    "c.execute('insert into t values(9)'); c.commit()",
  ].join('\n');
  const r = await bash(`
    sqlite3 p.db 'create table t(x); insert into t values(0);'
    python3 -c "${py}" > p.out &
    until [ -e ready ]; do sleep 0.05; done
    sqlite3 p.db 'insert into t values(1);'
    touch go; wait
    cat p.out; sqlite3 p.db 'select group_concat(x) from t'`);
  assert.deepEqual(r, { status: 0, stdout: 'P1 0\nP2 0,1\n0,1,9\n', stderr: '' });
});

test('appenders in three processes keep every line of a shared log (#665)', async (t) => {
  const bash = await booted(t);
  const n = 100;
  const py = `import time\nf = open('log', 'a')\nfor i in range(${n}):\n    f.write('p%d\\\\n' % i); f.flush(); time.sleep(0.01)`;
  const r = await bash(`
    ( exec 3>>log; for i in $(seq ${n}); do echo "a$i" >&3; sleep 0.01; done ) &
    ( exec 3>>log; for i in $(seq ${n}); do echo "b$i" >&3; sleep 0.01; done ) &
    python3 -c "${py}" &
    wait
    a=0; b=0; p=0
    while read l; do case $l in a*) a=$((a+1));; b*) b=$((b+1));; p*) p=$((p+1));; esac; done < log
    echo $a $b $p`);
  assert.deepEqual(r, { status: 0, stdout: `${n} ${n} ${n}\n`, stderr: '' });
});
