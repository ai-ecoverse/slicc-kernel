import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-sqlite3']) {
    await installDir(
      kernel,
      fileURLToPath(new URL(`${name}/`, modules)),
      `/node_modules/@ai-ecoverse/${name}`
    );
  }
  await installDir(
    kernel,
    fileURLToPath(new URL('fixtures/wlocktest/', import.meta.url)),
    '/node_modules/wlocktest'
  );
  return async (script) => {
    const r = await kernel.run(['bash', '-c', script], { cwd: '/tmp' });
    assert.equal(r.stderr.replace(/^.*database is locked.*\n/m, ''), '', script);
    return r;
  };
}

test('slicc.fcntl_lock answers bad calls by the ABI, and F_GETLK without a conflict sets only l_type (#722)', async (t) => {
  const sh = await booted(t);
  const r = await sh(
    'touch f; wlocktest open 0 rw f set 0 w 0 0 10 get 0 w 0 0 1 cmd 0 99 set 0 7 0 0 1 set 0 w 5 0 1 set 0 w 0 -5 1 get 0 u 0 0 1 badfd open 1 r f set 1 w 0 0 1 get 1 w 0 0 1 open 2 w f set 2 r 0 0 1'
  );
  assert.equal(
    r.stdout,
    [
      'set ok',
      'get unlck untouched',
      'cmd EINVAL',
      'set EINVAL',
      'set EINVAL',
      'set EINVAL',
      'get EINVAL',
      'badfd EBADF',
      'set EBADF',
      'get unlck untouched',
      'set EBADF',
      '',
    ].join('\n')
  );
});

test('two WASIX processes: a conflict is EAGAIN, a disjoint range is free, F_GETLK names the holder and its range from SEEK_CUR (#722)', async (t) => {
  const sh = await booted(t);
  const r = await sh(
    'touch f; wlocktest open 0 rw f seek 0 100 set 0 w 1 0 10 pid touch r await g & wlocktest await r open 0 rw f set 0 w 0 105 1 set 0 w 0 110 5 get 0 r 0 0 0 touch g; wait'
  );
  const pid = /pid (\d+)/.exec(r.stdout)?.[1];
  assert.equal(
    r.stdout.replace(/pid \d+\n/, ''),
    `set ok\nset EAGAIN\nset ok\nget w 0 100 10 pid=${pid} pad=kept\n`
  );
});

test('a WASIX write lock keeps an Emscripten sqlite3 writer out, and an Emscripten sqlite3 transaction keeps a WASIX locker out (#722)', async (t) => {
  const sh = await booted(t);
  const wasix = await sh(
    'sqlite3 db "create table t(x)"; wlocktest open 0 rw db set 0 w 0 0 0 touch r await g & wlocktest await r; sqlite3 db "insert into t values(2)"; echo rc=$?; touch g; wait; sqlite3 db "select count(*) from t"'
  );
  assert.equal(wasix.stdout, 'set ok\nrc=1\n0\n');
  assert.match(wasix.stderr, /database is locked/);
  const emscripten = await sh(
    '(echo "begin immediate;"; echo "insert into t values(1);"; echo ".output r2"; echo "select 1;"; while [ ! -e g2 ]; do sleep 0.05; done; echo ".output stdout"; echo "commit;") | sqlite3 db & p=$!; wlocktest await r2 open 0 rw db get 0 w 0 0 0 set 0 w 0 0 0; echo sqlite=$p; touch g2; wait; wlocktest open 0 rw db set 0 w 0 0 0; sqlite3 db "select group_concat(x) from t"'
  );
  const pid = /sqlite=(\d+)/.exec(emscripten.stdout)?.[1];
  assert.equal(
    emscripten.stdout,
    `get w 0 1073741825 1 pid=${pid} pad=kept\nset EAGAIN\nsqlite=${pid}\nset ok\n1\n`
  );
});

test('F_SETLKW waits for the holder to exit, and a signal with a handler ends the wait with EINTR (#722)', async (t) => {
  const sh = await booted(t);
  const waited = await sh(
    'touch f; wlocktest open 0 rw f set 0 w 0 0 0 touch r await g & wlocktest await r open 0 rw f setw 0 w 0 0 0 & sleep 0.3; echo released; touch g; wait'
  );
  assert.equal(waited.stdout, 'set ok\nreleased\nsetw ok\n');
  const interrupted = await sh(
    'rm -f r g; wlocktest open 0 rw f set 0 w 0 0 0 touch r await g & wlocktest await r trap open 0 rw f setw 0 w 0 0 0 & b=$!; sleep 0.3; kill -USR1 $b; wait $b; touch g; wait'
  );
  assert.equal(interrupted.stdout, 'set ok\nsetw EINTR\n');
});

test('F_SETLKW that would close a cycle is EDEADLK, and the other waiter gets the lock once that process exits (#722)', async (t) => {
  const sh = await booted(t);
  const r = await sh(
    'touch f; wlocktest open 0 rw f set 0 w 0 0 1 touch ra await ga setw 0 w 0 1 1 & wlocktest open 0 rw f set 0 w 0 1 1 touch rb await gb setw 0 w 0 0 1 & wlocktest await ra await rb; touch ga; sleep 0.3; touch gb; wait'
  );
  assert.deepEqual(r.stdout.trim().split('\n').sort(), [
    'set ok',
    'set ok',
    'setw EDEADLK',
    'setw ok',
  ]);
});

test("a fork child does not hold its parent's lock, closing another descriptor of the file drops the lock, and exit releases it (#722)", async (t) => {
  const sh = await booted(t);
  const fork = await sh('touch f; wlocktest open 0 rw f set 0 w 0 0 0 fork 0');
  assert.equal(fork.stdout, 'set ok\nchild get w parent=1\nchild set EAGAIN\n');
  const closed = await sh(
    'wlocktest open 0 rw f open 1 r f set 0 w 0 0 0 touch r1 await g1 close 1 touch r2 await g2 & wlocktest await r1 open 0 rw f set 0 w 0 0 0 touch g1 await r2 set 0 w 0 0 0 touch g2; wait'
  );
  assert.equal(closed.stdout, 'set ok\nset EAGAIN\nset ok\n');
  const exited = await sh(
    'rm -f g; wlocktest open 0 rw f set 0 w 0 0 0; wlocktest open 0 rw f set 0 w 0 0 0'
  );
  assert.equal(exited.stdout, 'set ok\nset ok\n');
});
