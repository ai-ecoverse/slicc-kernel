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

async function booted(t, packages) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', ...packages]) await install(kernel, name);
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp' });
}

const MARK = 'echo ".output ready"; echo "select 1;"; echo ".output stdout";';

test('a second sqlite3 writer gets "database is locked" while the first holds its transaction, and waits with a busy timeout (#665)', async (t) => {
  const bash = await booted(t, ['wasm-sqlite3']);
  const r = await bash(`
    sqlite3 c.db 'create table t(x);'
    ( echo "begin immediate;"; echo "insert into t values(1);"; ${MARK}
      until [ -e go ]; do sleep 0.05; done
      echo "commit;" ) | sqlite3 c.db > a.out 2>&1 &
    until [ -e ready ]; do sleep 0.05; done
    sqlite3 c.db 'insert into t values(2);' 2> b.err; echo "B $?"
    ( sqlite3 -cmd '.timeout 20000' c.db 'insert into t values(3);'; echo "C $?" ) > c.out 2>&1 &
    sleep 0.5; touch go; wait
    cat a.out b.err c.out; sqlite3 c.db 'select group_concat(x) from t; pragma integrity_check;'`);
  assert.deepEqual(r, {
    status: 0,
    stdout: 'B 1\nError in 2nd command line argument: database is locked\nC 0\n1,3\nok\n',
    stderr: '',
  });
});

test('two git commits at once in one repository both land, and no index.lock is left (#665)', async (t) => {
  const bash = await booted(t, ['wasm-git']);
  const commit = (name) =>
    `( echo ${name} > ${name}; until git add ${name} 2>/dev/null && git commit -qm ${name} 2>/dev/null; do sleep 0.05; done )`;
  const r = await bash(`
    git config --global user.name kernel && git config --global user.email kernel@example.com
    git init -q r && cd r && echo base > base && git add base && git commit -qm base
    ${commit('one')} & ${commit('two')} & wait
    git log --format=%s | sort; git status --porcelain; [ -e .git/index.lock ]; echo "lock $?"; git fsck 2>&1 | wc -l`);
  assert.deepEqual(r, { status: 0, stdout: 'base\none\ntwo\nlock 1\n0\n', stderr: '' });
});
