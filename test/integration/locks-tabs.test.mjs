import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const PYTHON_RUNTIME = { skip: /^lib\/libpython[^/]*\.a$/ };

const chrome = await launch();
after(() => chrome.close());

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab(page) {
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  const sh = (script) =>
    other.evaluate((s) => window.kernel.run(['bash', '-c', s], { cwd: '/home' }), script);
  return { page: other, sh };
}

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(lines.join('\n')).toString('base64')} | base64 -d)"`;

const HOLD = (path, flag) =>
  py([
    'import fcntl, os, time',
    `f = open('${path}', 'a+b')`,
    'fcntl.lockf(f, fcntl.LOCK_EX)',
    `open('${flag}.held', 'w').close()`,
    `while not os.path.exists('${flag}.go'):`,
    '    time.sleep(0.05)',
    "print('released', flush=True)",
  ]);

const TRY = (path) =>
  py([
    'import errno, fcntl',
    `f = open('${path}', 'a+b')`,
    'try:',
    '    fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    "    print('got', flush=True)",
    'except OSError as e:',
    "    print('busy', errno.errorcode[e.errno], flush=True)",
  ]);

const WAIT = (path) =>
  py([
    'import fcntl, time',
    `f = open('${path}', 'a+b')`,
    't = time.time()',
    'fcntl.lockf(f, fcntl.LOCK_EX)',
    "print('waited', flush=True)",
  ]);

async function heldBy(sh, flag) {
  for (let i = 0; i < 400; i++) {
    if ((await sh(`test -e ${flag}.held`)).status === 0) return;
    await delay(50);
  }
  throw new Error(`${flag} never held`);
}

async function setup(t) {
  const first = await booted(chrome, t);
  await installPackage(first.page, 'wasix-python', PYTHON_RUNTIME);
  await installPackage(first.page, 'wasm-sqlite3');
  await first.page.evaluate(
    (n) => window.copyTree('fixtures/flocktest/', 'node_modules/flocktest/', n),
    ['package.json', 'bin/flocktest.wasm']
  );
  const sh = (script) => first.bash(script, { cwd: '/home' });
  return { first: { page: first.page, sh }, second: await tab(first.page) };
}

test('a record lock one tab holds keeps another tab out, and sqlite3 there finds the database locked (#675)', {
  timeout: 180_000,
}, async (t) => {
  const { first, second } = await setup(t);
  await first.sh('rm -f a.* && sqlite3 a.db "create table t(x)"');
  const holder = first.sh(HOLD('a.db', 'a'));
  await heldBy(first.sh, 'a');
  assert.equal((await second.sh(TRY('a.db'))).stdout, 'busy EAGAIN\n');
  const insert = await second.sh('sqlite3 a.db "insert into t values(1)"; echo "rc=$?"');
  assert.match(insert.stderr + insert.stdout, /database is locked/);
  const waiter = second.sh(WAIT('a.db'));
  await delay(300);
  await first.sh('touch a.go');
  assert.equal((await holder).stdout, 'released\n');
  assert.equal((await waiter).stdout, 'waited\n');
});

test('flock and a rename across tabs: flock -n is EWOULDBLOCK, and a lock follows its file to its new name (#675)', {
  timeout: 180_000,
}, async (t) => {
  const { first, second } = await setup(t);
  await first.sh('rm -f f.* r.* && : > f.lock && : > r.file');
  const flocker = first.sh('flocktest open 0 rw f.lock flock 0 ex touch f.held await f.go close 0');
  await heldBy(first.sh, 'f');
  assert.equal(
    (await second.sh('flocktest open 0 rw f.lock flock 0 exnb')).stdout,
    'flock EAGAIN\n'
  );
  await first.sh('touch f.go');
  await flocker;
  assert.equal((await second.sh('flocktest open 0 rw f.lock flock 0 exnb')).stdout, 'flock ok\n');
  const renamed = first.sh(HOLD('r.file', 'r'));
  await heldBy(first.sh, 'r');
  await second.sh('mv r.file r.moved');
  assert.equal((await second.sh(TRY('r.moved'))).stdout, 'busy EAGAIN\n');
  await first.sh('touch r.go');
  await renamed;
});

test("a tab's wait ends when the holding tab closes, and survives the leader closing while a third tab holds the lock (#675)", {
  timeout: 240_000,
}, async (t) => {
  const { first, second } = await setup(t);
  await first.sh('rm -f c.* d.* && : > c.lock && : > d.lock');
  first.sh(HOLD('c.lock', 'c')).catch(() => undefined);
  await heldBy(first.sh, 'c');
  const waiter = second.sh(WAIT('c.lock'));
  await delay(500);
  const third = await tab(second.page);
  void third.sh(HOLD('d.lock', 'd'));
  await heldBy(third.sh, 'd');
  const blocked = second.sh(WAIT('d.lock'));
  await delay(300);
  await first.page.close();
  assert.equal((await waiter).stdout, 'waited\n');
  let done = false;
  void blocked.then(() => (done = true));
  await delay(1500);
  assert.equal(done, false, 'the wait on the third tab’s lock outlives the leader');
  await third.sh('touch d.go');
  assert.equal((await blocked).stdout, 'waited\n');
});

test('a wait that would close a cycle across tabs is EDEADLK (#675)', {
  timeout: 180_000,
}, async (t) => {
  const { first, second } = await setup(t);
  await first.sh('rm -f x.* y.* && : > x.lock && : > y.lock');
  const cycle = (mine, theirs, flag) =>
    py([
      'import errno, fcntl, os, time',
      `a = open('${mine}', 'a+b')`,
      'fcntl.lockf(a, fcntl.LOCK_EX)',
      `open('${flag}.held', 'w').close()`,
      `while not os.path.exists('${flag}.go'):`,
      '    time.sleep(0.05)',
      `b = open('${theirs}', 'a+b')`,
      'try:',
      '    fcntl.lockf(b, fcntl.LOCK_EX)',
      "    print('locked', flush=True)",
      'except OSError as e:',
      "    print('deadlock', errno.errorcode[e.errno], flush=True)",
    ]);
  const one = first.sh(cycle('x.lock', 'y.lock', 'x'));
  const two = second.sh(cycle('y.lock', 'x.lock', 'y'));
  await heldBy(first.sh, 'x');
  await heldBy(first.sh, 'y');
  await first.sh('touch x.go');
  await delay(500);
  await first.sh('touch y.go');
  const outs = [(await one).stdout, (await two).stdout].sort();
  assert.deepEqual(outs, ['deadlock EDEADLK\n', 'locked\n']);
});

test('a lock call from a tab that is not the leader takes one BroadcastChannel round trip, with the leader tab in the background (#675)', {
  timeout: 180_000,
}, async (t) => {
  const { first, second } = await setup(t);
  const loop = py([
    'import fcntl, time',
    "f = open('rt.lock', 'a+b')",
    'n = 200',
    't = time.time()',
    'for _ in range(n):',
    '    fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    '    fcntl.lockf(f, fcntl.LOCK_UN)',
    "print('per-call-ms %.3f' % ((time.time() - t) * 1000 / (2 * n)), flush=True)",
  ]);
  const leader = await first.sh(loop);
  await second.page.bringToFront?.();
  const follower = await second.sh(loop);
  console.log(
    `lock call: leader ${leader.stdout.trim()}, non-leader with the leader tab in the background ${follower.stdout.trim()}`
  );
  assert.match(follower.stdout, /^per-call-ms \d+\.\d{3}\n$/);
});

test('sqlite3 updating one database from two tabs on one OPFS root never fails to open it: contention waits, it is not CANTOPEN (#950)', {
  timeout: 600_000,
}, async (t) => {
  const { first, second } = await setup(t);
  const made = await first.sh(
    'rm -f u.db* && sqlite3 u.db "create table t(n); insert into t values(0)"'
  );
  assert.equal(made.status, 0, made.stderr);
  const loop =
    'fails=0; for i in $(seq 50); do sqlite3 -cmd ".timeout 20000" u.db "update t set n = n + 1" || fails=$((fails + 1)); done; echo "fails $fails"';
  const runs = await Promise.all([first.sh(loop), second.sh(loop)]);
  const n = (await first.sh('sqlite3 u.db "select n from t"')).stdout.trim();
  console.log(`two tabs, 50 updates each: ${runs.map((r) => r.stdout.trim()).join(', ')}, n=${n}`);
  for (const r of runs) assert.doesNotMatch(r.stderr, /unable to open database file/);
  assert.deepEqual(
    runs.map((r) => r.stdout),
    ['fails 0\n', 'fails 0\n']
  );
});
