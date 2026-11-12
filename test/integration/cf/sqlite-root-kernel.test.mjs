import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sqlStorage } from './sqlite-root-adapter.mjs';
import { BASELINE, bash, install, memoryKernel, sqliteKernel } from './sqlite-root-helpers.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-sqlite-root-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'root.sqlite');
}

function sane(sql) {
  const q = (query) => sql.exec(query).toArray();
  return {
    orphans: q(
      'SELECT count(*) AS n FROM slicc_nodes c WHERE c.id <> 1 AND NOT EXISTS (SELECT 1 FROM slicc_nodes p WHERE p.id = c.parent AND p.dir = 1)'
    )[0].n,
    strayChunks: q(
      'SELECT count(*) AS n FROM slicc_chunks c WHERE NOT EXISTS (SELECT 1 FROM slicc_nodes n WHERE n.id = c.node AND n.dir = 0)'
    )[0].n,
    overlong: q(
      `SELECT count(*) AS n FROM slicc_chunks c JOIN slicc_nodes n ON n.id = c.node WHERE c.idx * ${256 * 1024} + length(c.data) > n.size`
    )[0].n,
    writers: q('SELECT count(*) AS n FROM slicc_writers')[0].n,
    staged: q('SELECT count(*) AS n FROM slicc_staged')[0].n,
  };
}

const CLEAN = { orphans: 0, strayChunks: 0, overlong: 0, writers: 0, staged: 0 };

test('the kernel runs bash and coreutils on the SQLite root: baseline cases', async (t) => {
  const sql = sqlStorage();
  t.after(() => sql.close());
  const kernel = await sqliteKernel(sql);
  t.after(() => kernel.terminate());
  await install(kernel);
  for (const [script, stdout] of BASELINE) {
    const r = await bash(kernel, script, { cwd: '/root' });
    assert.deepEqual({ script, status: r.status, stdout: r.stdout }, { script, status: 0, stdout });
  }
});

const SETUP = [
  'mkdir -p /data/sub/deep',
  'printf hello > /data/a.txt',
  'printf world > /data/sub/deep/b.txt',
  'chmod 640 /data/a.txt',
  'chmod 711 /data/sub',
  'chown alice:alice /data/sub/deep/b.txt',
  "touch -d '2001-02-03 04:05:06 UTC' /data/a.txt",
  'ln -s a.txt /data/link',
  'ln -s /data/sub/deep /data/dirlink',
  "printf 'x\\ty' > '/data/odd name \\ ; '",
  'mv /data/sub/deep/b.txt /data/sub/deep/c.txt',
].join(' && ');

const CHECK = [
  'stat -c "%n %a %U %G" /data/a.txt /data/sub /data/sub/deep/c.txt',
  'stat -c %s /data/a.txt',
  'stat -c %Y /data/a.txt',
  'readlink /data/link /data/dirlink',
  'cat /data/link /data/dirlink/c.txt',
  'echo',
  "cat '/data/odd name \\ ; '",
  'echo',
  'ls /data/sub/deep',
].join('; ');

const EXPECTED = [
  '/data/a.txt 640 root root',
  '/data/sub 711 root root',
  '/data/sub/deep/c.txt 644 alice alice',
  '5',
  String(Date.UTC(2001, 1, 3, 4, 5, 6) / 1000),
  'a.txt',
  '/data/sub/deep',
  'helloworld',
  'x\ty',
  'c.txt',
  '',
].join('\n');

test('a second kernel on the same database sees files, directories, modes, owners, mtimes and symlinks', async (t) => {
  const path = await scratch(t);
  const first = sqlStorage(path);
  const kernel = await sqliteKernel(first);
  await install(kernel);
  await kernel.users.add({ name: 'alice' });
  const made = await bash(kernel, SETUP);
  assert.equal(made.status, 0, made.stderr);
  const seen = await bash(kernel, CHECK);
  assert.equal(seen.stdout, EXPECTED, seen.stderr);
  kernel.terminate();
  first.close();

  const second = sqlStorage(path);
  t.after(() => second.close());
  assert.deepEqual(sane(second), CLEAN);
  const again = await sqliteKernel(second);
  t.after(() => again.terminate());
  assert.ok((await again.users.list()).some((user) => user.name === 'alice'));
  const r = await bash(again, CHECK);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, EXPECTED);
});

for (const [name, boot] of [
  ['the SQLite root', () => sqliteKernel(sqlStorage())],
  ['memoryRoot()', () => memoryKernel()],
]) {
  test(`hard links on ${name} are refused by OpfsFs the same way (EMLINK)`, async (t) => {
    const kernel = await boot();
    t.after(() => kernel.terminate());
    await install(kernel);
    const r = await bash(kernel, 'printf x > /a; ln /a /b; echo rc=$?; ls /b');
    assert.match(r.stderr, /Too many links/);
    assert.match(r.stdout, /rc=1/);
  });
}

test('an unclean stop (SIGKILL, no terminate) mid-writes leaves a consistent tree', async (t) => {
  const path = await scratch(t);
  const setup = sqlStorage(path);
  const kernel = await sqliteKernel(setup);
  await install(kernel);
  kernel.terminate();
  setup.close();

  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./sqlite-root-crash-child.mjs', import.meta.url)), path],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`the writer exited early: ${code}`)));
    child.stdout.on('data', (data) => {
      if (String(data).includes('started')) resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  child.removeAllListeners('exit');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;

  const sql = sqlStorage(path);
  t.after(() => sql.close());
  const before = sane(sql);
  assert.equal(before.orphans, 0);
  assert.equal(before.strayChunks, 0);
  assert.equal(before.overlong, 0);
  const again = await sqliteKernel(sql);
  t.after(() => again.terminate());
  assert.deepEqual(sane(sql), CLEAN);
  const listing = await bash(again, 'ls -laR /root/work > /dev/null && echo listed');
  assert.equal(listing.stdout, 'listed\n', listing.stderr);
  const count = Number((await bash(again, 'ls -d /root/work/d* | wc -l')).stdout.trim());
  assert.ok(count >= 3, `only ${count} directories were made before the kill`);
  const checked = await bash(
    again,
    [
      'bad=0',
      'for d in /root/work/d*; do',
      '  i=${d#/root/work/d}',
      '  if [ -e $d/g ]; then [ "$(cat $d/g)" = "$i" ] || { echo "bad g $d"; bad=1; }; fi',
      '  if [ -e $d/f ]; then [ "$(cat $d/f)" = "$i" ] || [ ! -s $d/f ] || { echo "bad f $d"; bad=1; }; fi',
      '  if [ -L $d/l ]; then [ "$(readlink $d/l)" = g ] || { echo "bad l $d"; bad=1; }; fi',
      'done',
      'if [ -e /root/work/big ]; then [ $(wc -c < /root/work/big) = 3000000 ] || { echo "bad big"; bad=1; }; fi',
      'echo bad=$bad',
    ].join('\n')
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /bad=0\n$/, checked.stdout);
  const after = await bash(
    again,
    'echo more > /root/work/after && cat /root/work/after && rm -r /root/work && echo gone'
  );
  assert.equal(after.stdout, 'more\ngone\n', after.stderr);
});
