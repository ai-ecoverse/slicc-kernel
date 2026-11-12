import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { sqliteMeta } from '../../../src/cloudflare/sqlite-meta.ts';
import { sqliteRoot } from '../../../src/cloudflare/sqlite-root.ts';
import { sqliteFlush } from '../../../src/cloudflare/sqlite-store.ts';
import { sqlStorage } from './sqlite-root-adapter.mjs';
import { bash, closeSql, install, sqliteKernel } from './sqlite-root-helpers.mjs';

const FILES_100 =
  'mkdir -p /root/w && cd /root/w && mkdir -p many && for i in $(seq 1 100); do echo "line $i" > many/f$i.txt; done; n=0; for f in many/*.txt; do read l < "$f"; n=$((n+1)); done; echo $n; cat many/*.txt | wc -l';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const commits = (sql) => sql.counted.transactions + sql.counted.writes;

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-sqlite-behind-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'root.sqlite');
}

function watcher(t, path) {
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  return {
    nodes: () => Number(db.prepare('SELECT count(*) AS n FROM slicc_nodes').get().n),
    meta: () => Number(db.prepare('SELECT count(*) AS n FROM slicc_meta').get().n),
  };
}

async function writeText(dir, name, text) {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
  return file;
}

test('the 100-file script commits far less often with write-behind', async (t) => {
  const counts = {};
  for (const [mode, sqlite] of [
    ['through', {}],
    ['behind', { writeBehind: true }],
  ]) {
    const sql = sqlStorage();
    const kernel = await sqliteKernel(sql, {}, sqlite);
    try {
      await install(kernel);
      sqliteFlush(sql);
      const before = commits(sql);
      const started = performance.now();
      const r = await bash(kernel, FILES_100);
      sqliteFlush(sql);
      assert.equal(r.stdout, '100\n100\n', r.stderr);
      counts[mode] = {
        commits: commits(sql) - before,
        ms: Math.round(performance.now() - started),
      };
    } finally {
      kernel.terminate();
      closeSql(sql);
    }
  }
  console.log(
    `100-file script on Node: write-through ${counts.through.commits} commits in ${counts.through.ms} ms, write-behind ${counts.behind.commits} commits in ${counts.behind.ms} ms`
  );
  assert.ok(counts.through.commits > 300, `write-through made ${counts.through.commits} commits`);
  assert.ok(counts.behind.commits <= 5, `write-behind made ${counts.behind.commits} commits`);
});

test('write-behind: reads see writes at once, the database only after the idle timer', async (t) => {
  const path = await scratch(t);
  const sql = sqlStorage(path);
  t.after(() => closeSql(sql));
  const root = sqliteRoot(sql, { writeBehind: { idleMs: 30, maxMs: 1000 } });
  const meta = sqliteMeta(sql);
  const seen = watcher(t, path);
  const nodes = seen.nodes();
  const dir = await root.getDirectoryHandle('d', { create: true });
  const file = await writeText(dir, 'a', 'hello');
  await meta.update('/d/a', () => ({ path: '/d/a', mode: 0o600 }));
  assert.equal(await (await file.getFile()).text(), 'hello');
  assert.deepEqual(await meta.get(['/d/a']), [{ path: '/d/a', mode: 0o600 }]);
  assert.deepEqual(
    (await meta.under('/d')).map((entry) => entry.path),
    ['/d/a']
  );
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  assert.deepEqual(names, ['a']);
  assert.equal(seen.nodes(), nodes);
  assert.equal(seen.meta(), 0);
  await sleep(120);
  assert.equal(seen.nodes(), nodes + 2);
  assert.equal(seen.meta(), 1);
  assert.equal(await (await file.getFile()).text(), 'hello');
});

test('write-behind: continuous writes flush at maxMs, a large overlay flushes at maxBytes', async (t) => {
  const sql = sqlStorage(await scratch(t));
  t.after(() => closeSql(sql));
  const root = sqliteRoot(sql, {
    writeBehind: { idleMs: 40, maxMs: 120, maxBytes: 1024 * 1024 },
  });
  const before = commits(sql);
  for (let i = 0; i < 60; i++) {
    await writeText(root, `f${i}`, `file ${i}`);
    await sleep(5);
  }
  const timed = commits(sql) - before;
  assert.ok(timed >= 2, `continuous writes for 300 ms flushed ${timed} times`);
  assert.ok(timed <= 6, `continuous writes for 300 ms flushed ${timed} times`);
  const quiet = sqliteRoot(sql, {
    writeBehind: { idleMs: 60000, maxMs: 60000, maxBytes: 1024 * 1024 },
  });
  sqliteFlush(sql);
  const sized = commits(sql);
  for (let i = 0; i < 6; i++) await writeText(quiet, `big${i}`, new Uint8Array(400 * 1024).fill(i));
  const flushed = commits(sql) - sized;
  assert.ok(
    flushed >= 2 && flushed <= 3,
    `6 x 400 KiB with a 1 MiB bound flushed ${flushed} times`
  );
});

test('write-behind: an unflushed window is lost whole on an unclean stop, the tree stays consistent', async (t) => {
  const path = await scratch(t);
  const first = sqlStorage(path);
  const root = sqliteRoot(first, { writeBehind: { idleMs: 60000, maxMs: 60000 } });
  const meta = sqliteMeta(first);
  const kept = await root.getDirectoryHandle('kept', { create: true });
  await writeText(kept, 'a', 'flushed');
  await meta.update('/kept/a', () => ({ path: '/kept/a', mode: 0o640 }));
  sqliteFlush(first);
  const lost = await root.getDirectoryHandle('lost', { create: true });
  await writeText(lost, 'b', 'never flushed');
  await writeText(kept, 'a', 'overwritten later');
  await kept.removeEntry('a');
  await meta.update('/lost/b', () => ({ path: '/lost/b', mode: 0o600 }));
  await meta.remove(['/kept/a']);
  first.close();

  const second = sqlStorage(path);
  t.after(() => closeSql(second));
  const again = sqliteRoot(second);
  const names = [];
  for await (const name of again.keys()) names.push(name);
  assert.deepEqual(names, ['kept']);
  const file = await (await again.getDirectoryHandle('kept')).getFileHandle('a');
  assert.equal(await (await file.getFile()).text(), 'flushed');
  assert.deepEqual(await sqliteMeta(second).get(['/kept/a', '/lost/b']), [
    { path: '/kept/a', mode: 0o640 },
    undefined,
  ]);
});

test('write-behind: a failed flush keeps the overlay and a later flush lands it', async (t) => {
  const path = await scratch(t);
  const sql = sqlStorage(path);
  const root = sqliteRoot(sql, { writeBehind: { idleMs: 60000, maxMs: 60000 } });
  await writeText(root, 'x', 'survives a failed flush');
  const transaction = sql.transaction;
  let refused = 0;
  sql.transaction = (fn) =>
    transaction(() => {
      fn();
      refused++;
      throw new Error('disk full');
    });
  const forced = sqliteRoot(sql, { transaction: sql.transaction });
  assert.throws(() => sqliteFlush(sql), /disk full/);
  assert.equal(refused, 1);
  assert.equal(
    await (await (await forced.getFileHandle('x')).getFile()).text(),
    'survives a failed flush'
  );
  sqliteRoot(sql, { transaction });
  sqliteFlush(sql);
  sql.close();
  const again = sqlStorage(path);
  t.after(() => closeSql(again));
  const file = await sqliteRoot(again).getFileHandle('x');
  assert.equal(await (await file.getFile()).text(), 'survives a failed flush');
});
