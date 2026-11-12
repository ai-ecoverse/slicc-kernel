import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import { sqliteRoot } from '../../../src/cloudflare/sqlite-root.ts';
import { sqlStorage } from './sqlite-root-adapter.mjs';
import { bash, install, memoryKernel, sqliteKernel } from './sqlite-root-helpers.mjs';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const MiB = 1024 * 1024;
const FILE = 64 * MiB;

function live() {
  gc();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-sqlite-big-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'root.sqlite');
}

test('a 64 MiB file written and read in 1 MiB pieces on the root keeps live memory near the piece size', async (t) => {
  const sql = sqlStorage(await scratch(t));
  t.after(() => sql.close());
  const root = sqliteRoot(sql);
  const handle = await root.getFileHandle('big', { create: true });
  const piece = new Uint8Array(MiB);
  const base = live();
  let wrote = 0;
  const writable = await handle.createWritable();
  for (let i = 0; i < FILE / MiB; i++) {
    piece.fill(i & 0xff);
    piece[0] = i >> 8;
    await writable.write(piece);
    wrote = Math.max(wrote, live() - base);
  }
  await writable.close();
  wrote = Math.max(wrote, live() - base);
  const file = await handle.getFile();
  assert.equal(file.size, FILE);
  let read = 0;
  for (let i = 0; i < FILE / MiB; i++) {
    const part = new Uint8Array(await file.slice(i * MiB, (i + 1) * MiB).arrayBuffer());
    assert.equal(part.length, MiB);
    assert.equal(part[0], i >> 8);
    assert.equal(part[MiB - 1], i & 0xff);
    read = Math.max(read, live() - base);
  }
  const patch = await handle.createWritable({ keepExistingData: true });
  await patch.write({ type: 'write', position: 40 * MiB - 3, data: new Uint8Array(6).fill(0xee) });
  await patch.close();
  const patched = await handle.getFile();
  const around = new Uint8Array(await patched.slice(40 * MiB - 4, 40 * MiB + 4).arrayBuffer());
  assert.deepEqual([...around], [39, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 40 & 0xff]);
  const patching = live() - base;
  console.log(
    `64 MiB on the SQLite root in 1 MiB pieces: peak live growth write ${(wrote / MiB).toFixed(2)} MiB, read ${(read / MiB).toFixed(2)} MiB, after a 6-byte patch ${(patching / MiB).toFixed(2)} MiB`
  );
  assert.ok(wrote < 8 * MiB, `writing grew live memory by ${wrote} bytes`);
  assert.ok(read < 8 * MiB, `reading grew live memory by ${read} bytes`);
  assert.ok(patching < 8 * MiB, `patching grew live memory by ${patching} bytes`);
});

function script(count, at = 41943040) {
  return [
    `dd if=/dev/zero of=/root/big bs=1M count=${count} 2>/dev/null`,
    `printf XYZ | dd of=/root/big bs=1 seek=${at} conv=notrunc 2>/dev/null`,
    'ls -l /root/big | cut -d" " -f5',
    'cksum < /root/big',
    `dd if=/root/big bs=1 skip=${at - 1} count=5 2>/dev/null | od -An -c | tr -s " "`,
  ].join('; ');
}

async function sampled(kernel, text) {
  const base = live();
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, live() - base);
  }, 25);
  const r = await bash(kernel, text);
  clearInterval(timer);
  assert.equal(r.status, 0, r.stderr);
  return Math.max(peak, live() - base);
}

test('the kernel writes and reads a 64 MiB file on the SQLite root in pieces: memory does not grow with the file', async (t) => {
  const timed = {};
  for (const [name, boot] of [
    ['memory', () => memoryKernel()],
    ['sqlite', async () => sqliteKernel(sqlStorage(await scratch(t)))],
  ]) {
    const kernel = await boot();
    try {
      await install(kernel);
      const started = performance.now();
      const r = await bash(kernel, script(64));
      assert.equal(r.status, 0, r.stderr);
      timed[name] = { stdout: r.stdout, ms: Math.round(performance.now() - started) };
    } finally {
      kernel.terminate();
    }
  }
  assert.equal(timed.sqlite.stdout, timed.memory.stdout);
  assert.match(timed.sqlite.stdout, /^67108864\n\d+ 67108864\n \\0 X Y Z \\0\n$/);
  const sql = sqlStorage(await scratch(t));
  t.after(() => sql.close());
  const kernel = await sqliteKernel(sql);
  t.after(() => kernel.terminate());
  await install(kernel);
  const small = await sampled(kernel, script(0, 40));
  const big = await sampled(kernel, script(64));
  console.log(
    `kernel, 64 MiB dd + 3-byte patch + cksum + ranged read: memory root ${timed.memory.ms} ms, SQLite root ${timed.sqlite.ms} ms; SQLite peak live growth ${(big / MiB).toFixed(1)} MiB against ${(small / MiB).toFixed(1)} MiB for the same script on a 43-byte file`
  );
  assert.ok(
    big < small + 16 * MiB,
    `64 MiB grew live memory by ${big} bytes, the small run by ${small}`
  );
});
