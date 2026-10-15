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

const fixture = new URL('fixtures/locktest/', import.meta.url);

async function booted(t, packages, cwd = '/tmp') {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', ...packages]) await install(kernel, name);
  for (const file of ['package.json', 'bin/locktest', 'bin/locktest.wasm']) {
    await kernel.writeFile(
      `/node_modules/locktest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  if (cwd !== '/tmp') {
    await kernel.run(['mkdir', '-p', cwd], { cwd: '/' });
    await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: cwd });
  }
  return (script) => kernel.run(['bash', '-c', script], { cwd });
}

const lines = (text) => text.trim().split('\n');

test('F_SETLK between processes: a conflicting lock is EAGAIN, and F_GETLK names the holder and its range (#665)', async (t) => {
  const bash = await booted(t, []);
  const r = await bash(`
    locktest pid open f rw lock w 10 5 touch held until go > a.out &
    until [ -e held ]; do sleep 0.05; done
    locktest open f rw lock w 12 1 getlk w 0 0 lock r 0 10 getlk w 0 10 lock w 15 0
    touch go; wait; cat a.out`);
  assert.equal(r.status, 0, r.stderr);
  const [b1, b2, b3, b4, b5, a1, a2] = lines(r.stdout);
  const pid = Number(a1.split(' ')[1]);
  assert.ok(pid > 1, a1);
  assert.deepEqual(
    [b1, b2, b3, b4, b5, a2],
    [
      'lock EAGAIN',
      `getlk w pid=${pid} start=10 len=5`,
      'lock ok',
      'getlk none',
      'lock ok',
      'lock ok',
    ]
  );
});

const MARK = 'echo ".output ready"; echo "select 1;"; echo ".output stdout";';

test('a second sqlite3 writer gets "database is locked" while the first holds its transaction, and waits with a busy timeout (#665)', async (t) => {
  const bash = await booted(t, ['wasm-sqlite3']);
  const r = await bash(`
    sqlite3 c.db 'create table t(x);'
    ( echo ".timeout 20000"; echo "begin immediate;"; echo "insert into t values(1);"; ${MARK}
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
    `( echo ${name} > ${name}; until git cat-file -e HEAD:${name} 2>/dev/null; do { git add ${name} && git commit -qm ${name}; } > /dev/null 2>&1; sleep 0.05; done )`;
  const r = await bash(`
    git config --global user.name kernel && git config --global user.email kernel@example.com
    git init -q r && cd r && echo base > base && git add base && git commit -qm base
    ${commit('one')} & ${commit('two')} & wait
    git ls-files; git status --porcelain; [ -e .git/index.lock ]; echo "lock $?"; git fsck --no-dangling 2>&1 | wc -l`);
  assert.deepEqual(r, { status: 0, stdout: 'base\none\ntwo\nlock 1\n0\n', stderr: '' });
});

test('F_SETLKW waits in the kernel until the holder lets go, a signal ends the wait with EINTR, and a cycle is EDEADLK (#665)', async (t) => {
  const bash = await booted(t, []);
  const r = await bash(`
    locktest open f rw lock w 0 1 touch held until go sleep 300 touch released lock u 0 1 > a.out &
    until [ -e held ]; do sleep 0.05; done
    locktest alarm 1 open f rw lockw w 0 1
    touch go; locktest open f rw lockw w 0 1; [ -e released ] && echo released
    wait; cat a.out
    locktest open g rw lock w 0 1 touch a0 until b1 lockw w 1 1 > c.out &
    until [ -e a0 ]; do sleep 0.05; done
    locktest open g rw lock w 1 1 touch b1 sleep 300 lockw w 0 1 lock u 1 1
    wait; cat c.out`);
  assert.deepEqual(r, {
    status: 0,
    stdout:
      'lockw EINTR\nlockw ok\nreleased\nlock ok\nlock ok\n' +
      'lock ok\nlockw EDEADLK\nlock ok\nlock ok\nlockw ok\n',
    stderr: '',
  });
});

test('fcntl locks: a fork child does not get them, exec keeps them under the pid, closing any descriptor of the file or exit drops them, every hard-link name is the same file, and the access mode must allow the lock (#665)', async (t) => {
  const bash = await booted(t, [], '/mnt/t');
  const r = await bash(`
    locktest pid open f rw lock w 0 0 fork getlk w 0 0 lock w 5 1 end > fork.out
    ln f g
    locktest pid open f rw lock w 0 0 exec inherit touch execd until go > exec.out &
    until [ -e execd ]; do sleep 0.05; done
    locktest open g r getlk w 0 0; touch go; wait
    locktest open f rw lock w 0 0 reopen g touch held until go2 > close.out &
    until [ -e held ]; do sleep 0.05; done
    locktest open f rw getlk w 0 0; touch go2; wait
    locktest open f rw lock w 0 0; locktest open f rw getlk w 0 0
    locktest open f r lock w 0 1 lock r 0 1 open f w lock r 0 1 lock w 0 1
    cat fork.out exec.out close.out`);
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r.stdout);
  const forkPid = Number(out[out.length - 7].split(' ')[1]);
  const execPid = Number(out[out.length - 3].split(' ')[1]);
  assert.deepEqual(out, [
    `getlk w pid=${execPid} start=0 len=0`,
    'getlk none',
    'lock ok',
    'getlk none',
    'lock EBADF',
    'lock ok',
    'lock EBADF',
    'lock ok',
    `pid ${forkPid}`,
    'lock ok',
    `getlk w pid=${forkPid} start=0 len=0`,
    'lock EAGAIN',
    `pid ${execPid}`,
    'lock ok',
    'lock ok',
  ]);
});
