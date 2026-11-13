import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sqliteFlush } from '../../../src/cloudflare/sqlite-store.ts';
import { sqlStorage } from './sqlite-root-adapter.mjs';
import { bash, closeSql, install, memoryKernel, sqliteKernel } from './sqlite-root-helpers.mjs';

const DIRS = 40;
const PER_DIR = Number(process.env.SLICC_NUMBERS_PER_DIR ?? 10);
const FILES = DIRS * PER_DIR;

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name, size, type, mode) {
  const block = new Uint8Array(512);
  const put = (text, at) => block.set(new TextEncoder().encode(text), at);
  put(name, 0);
  put(octal(mode, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(1700000000, 12), 136);
  put('        ', 148);
  put(type, 156);
  put('ustar\u000000', 257);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function tarball() {
  const parts = [];
  let total = 0;
  const push = (bytes) => {
    parts.push(bytes);
    total += bytes.length;
  };
  for (let d = 0; d < DIRS; d++) {
    push(header(`tree/d${d}/`, 0, '5', 0o755));
    for (let f = 0; f < PER_DIR; f++) {
      const body = new TextEncoder().encode(
        `file ${d}/${f} `.repeat(10 + ((d * PER_DIR + f) % 90))
      );
      push(header(`tree/d${d}/f${f}.txt`, body.length, '0', 0o644));
      push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) push(new Uint8Array(pad));
    }
  }
  push(new Uint8Array(1024));
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const time = async (work) => {
  const started = performance.now();
  const value = await work();
  return [Math.round(performance.now() - started), value];
};

test(`numbers: unpacking ${FILES} small files with tar and reading them back, memory root against SQLite root`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-sqlite-tree-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = tarball();
  const rows = {};
  for (const [name, boot] of [
    ['memory', async () => ({ kernel: await memoryKernel() })],
    [
      'sqlite',
      async () => {
        const sql = sqlStorage(join(dir, 'root.sqlite'));
        return { kernel: await sqliteKernel(sql), sql };
      },
    ],
    [
      'behind',
      async () => {
        const sql = sqlStorage(join(dir, 'behind.sqlite'));
        return { kernel: await sqliteKernel(sql, {}, { writeBehind: true }), sql };
      },
    ],
  ]) {
    const { kernel, sql } = await boot();
    try {
      await install(kernel, ['wasm-bash', 'wasm-coreutils', 'wasm-tar']);
      await kernel.writeFile('/root/tree.tar', archive);
      const before = sql ? { ...sql.counted } : undefined;
      if (sql) sqliteFlush(sql);
      const commitsBefore = sql ? sql.counted.transactions + sql.counted.writes : 0;
      const [unpack, untar] = await time(async () => {
        const r = await bash(kernel, 'mkdir -p /root/x && tar -xf /root/tree.tar -C /root/x');
        if (sql) sqliteFlush(sql);
        return r;
      });
      const commitCount = sql ? sql.counted.transactions + sql.counted.writes - commitsBefore : 0;
      assert.equal(untar.status, 0, untar.stderr);
      const wrote = sql ? { ...sql.counted } : undefined;
      const [list, listed] = await time(() => bash(kernel, 'ls -1 /root/x/tree/d*/* | wc -l'));
      assert.equal(listed.stdout.trim(), String(FILES));
      const [cat, catted] = await time(() => bash(kernel, 'cat /root/x/tree/d*/* | cksum'));
      assert.equal(catted.status, 0, catted.stderr);
      const [api, sizes] = await time(async () => {
        let total = 0;
        for (let d = 0; d < DIRS; d++) {
          for (let f = 0; f < PER_DIR; f++) {
            total += (await kernel.readFile(`/root/x/tree/d${d}/f${f}.txt`)).length;
          }
        }
        return total;
      });
      rows[name] = {
        unpack,
        list,
        cat,
        api,
        cksum: catted.stdout.trim(),
        bytes: sizes,
        ...(sql
          ? {
              commits: commitCount,
              statements: wrote.statements - before.statements,
              rowsWritten: wrote.rowsWritten - before.rowsWritten,
              readStatements: sql.counted.statements - wrote.statements,
            }
          : {}),
      };
    } finally {
      kernel.terminate();
      if (sql) closeSql(sql);
    }
  }
  console.log(
    [
      `${FILES} files, ${rows.memory.bytes} bytes, ms (memory / sqlite write-through / sqlite write-behind):`,
      `tar -xf ${rows.memory.unpack} / ${rows.sqlite.unpack} / ${rows.behind.unpack}`,
      `ls ${rows.memory.list} / ${rows.sqlite.list} / ${rows.behind.list}`,
      `cat * | cksum ${rows.memory.cat} / ${rows.sqlite.cat} / ${rows.behind.cat}`,
      `kernel.readFile each ${rows.memory.api} / ${rows.sqlite.api} / ${rows.behind.api}`,
      `SQLite unpack, write-through: ${rows.sqlite.commits} commits, ${rows.sqlite.statements} statements, ${rows.sqlite.rowsWritten} rows written; read back: ${rows.sqlite.readStatements} statements`,
      `SQLite unpack, write-behind: ${rows.behind.commits} commits, ${rows.behind.statements} statements, ${rows.behind.rowsWritten} rows written; read back: ${rows.behind.readStatements} statements`,
    ].join('\n  ')
  );
  assert.equal(rows.sqlite.cksum, rows.memory.cksum);
  assert.equal(rows.sqlite.bytes, rows.memory.bytes);
  assert.equal(rows.behind.cksum, rows.memory.cksum);
  assert.equal(rows.behind.bytes, rows.memory.bytes);
  assert.ok(rows.behind.commits * 10 < rows.sqlite.commits, JSON.stringify(rows));
});
