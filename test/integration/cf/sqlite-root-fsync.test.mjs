import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sqliteFlush } from '../../../src/cloudflare/sqlite-store.ts';
import { sqlStorage } from './sqlite-root-adapter.mjs';
import { bash, closeSql, install, sqliteKernel } from './sqlite-root-helpers.mjs';

const PACKAGES = ['wasm-bash', 'wasm-coreutils', 'wasm-sqlite3'];

async function killedAfter(t, path, emscripten, script) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./sqlite-root-fsync-child.mjs', import.meta.url)),
      path,
      emscripten,
      script,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await Promise.race([
    new Promise((resolve) => {
      child.stdout.on('data', (data) => {
        if (String(data).includes('ready')) resolve();
      });
    }),
    exited.then((code) => {
      throw new Error(`the writer exited before it was ready: ${code}`);
    }),
  ]);
  child.kill('SIGKILL');
  await exited;
}

async function prepared(t) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-sqlite-fsync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'root.sqlite');
  const sql = sqlStorage(path);
  const kernel = await sqliteKernel(sql);
  await install(kernel, PACKAGES);
  kernel.terminate();
  closeSql(sql);
  return path;
}

async function after(path, script) {
  const sql = sqlStorage(path);
  const kernel = await sqliteKernel(sql, {}, { writeBehind: true });
  try {
    return await bash(kernel, script);
  } finally {
    kernel.terminate();
    closeSql(sql);
  }
}

const SYNCED = [
  'echo dd-fsync | dd of=/root/dd-fsync conv=fsync 2>/dev/null',
  'echo dd-fdatasync | dd of=/root/dd-fdatasync conv=fdatasync 2>/dev/null',
  'echo sync-file > /root/sync-file; chmod 640 /root/sync-file; sync /root/sync-file',
  'echo synced-meta > /root/synced-meta; ln -s synced-meta /root/synced-link; sync -d /root/synced-meta',
  'sqlite3 /root/db.sqlite "pragma journal_mode=truncate; pragma synchronous=full; create table t(x); insert into t values (42);" > /dev/null',
  'mkdir -p /root/never && echo unsynced > /root/never/u',
].join('; ');

const CHECK = [
  'cat /root/dd-fsync /root/dd-fdatasync /root/sync-file /root/synced-meta',
  'stat -c %a /root/sync-file',
  'readlink /root/synced-link',
  'sqlite3 /root/db.sqlite "select x from t"',
  'test -e /root/never && echo kept || echo lost',
].join('; ');

test('fsync, fdatasync, sync FILE and sqlite3 make their writes durable before any run() returns (emscripten: kernel, as on Cloudflare)', async (t) => {
  const path = await prepared(t);
  await killedAfter(t, path, 'kernel', SYNCED);
  const r = await after(path, CHECK);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    'dd-fsync\ndd-fdatasync\nsync-file\nsynced-meta\n640\nsynced-meta\n42\nlost\n'
  );
});

test('sqlite3 in its default journal mode: the journal unlink after the last fsync is in the lost window, so the last transaction rolls back whole', async (t) => {
  const path = await prepared(t);
  await killedAfter(
    t,
    path,
    'kernel',
    'sqlite3 /root/db.sqlite "create table t(x); insert into t values (1);"; sqlite3 /root/db.sqlite "insert into t values (2);"'
  );
  const r = await after(
    path,
    'ls /root; sqlite3 /root/db.sqlite "select count(*) from t; pragma integrity_check;"; ls /root'
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'db.sqlite\ndb.sqlite-journal\n1\nok\ndb.sqlite\n');
});

test('without a durable hook nothing changes: fsync succeeds and write-behind keeps its window', async (t) => {
  const sql = sqlStorage();
  const kernel = await sqliteKernel(
    sql,
    { emscripten: 'kernel' },
    { writeBehind: { idleMs: 600000, maxMs: 600000 } }
  );
  t.after(() => {
    kernel.terminate();
    closeSql(sql);
  });
  await install(kernel, PACKAGES);
  sqliteFlush(sql);
  const before = sql.counted.transactions + sql.counted.writes;
  const r = await bash(kernel, 'echo x | dd of=/root/x conv=fsync 2>/dev/null; cat /root/x');
  assert.equal(r.stdout, 'x\n', r.stderr);
  assert.equal(sql.counted.transactions + sql.counted.writes, before);
});
