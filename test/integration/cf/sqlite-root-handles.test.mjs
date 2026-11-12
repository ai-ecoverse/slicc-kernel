import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRoot } from '../../../dist/node.js';
import { CHUNK_BYTES, sqliteRoot } from '../../../src/cloudflare/sqlite-root.ts';
import { sqliteFlush } from '../../../src/cloudflare/sqlite-store.ts';
import { sqlStorage } from './sqlite-root-adapter.mjs';

function roots(t) {
  const through = sqlStorage();
  const behind = sqlStorage();
  t.after(() => {
    sqliteFlush(behind);
    through.close();
    behind.close();
  });
  return [
    ['memory', memoryRoot()],
    ['sqlite', sqliteRoot(through)],
    ['sqlite-behind', sqliteRoot(behind, { writeBehind: { idleMs: 1, maxMs: 5 } })],
  ];
}

async function outcome(work) {
  try {
    const value = await work();
    return { value };
  } catch (err) {
    return { error: err?.name ?? String(err) };
  }
}

async function same(pair, work) {
  const results = [];
  for (const [, root] of pair) results.push(await outcome(() => work(root)));
  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
  return results[0];
}

async function bytes(root, path) {
  const parts = path.split('/');
  const name = parts.pop();
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  const file = await (await dir.getFileHandle(name)).getFile();
  return [...new Uint8Array(await file.arrayBuffer())];
}

async function listing(dir) {
  const out = [];
  for await (const [name, handle] of dir.entries()) out.push(`${handle.kind}:${name}`);
  return out.sort();
}

const NAMES = [
  'plain',
  'with space',
  'tab\there',
  'new\nline',
  'back\\slash',
  'colon:star*?<>|"',
  'nul\u0000inside',
  'lone\ud800surrogate',
  'other\udfffhalf',
  'pair\ud83d\ude00',
  'Ünïcödé',
  'CASE',
  'case',
  '.hidden',
  '...',
  ' ',
  'x'.repeat(255),
  '\u0001\u001f\u007f',
];

test('names: any string a POSIX name may carry round-trips, invalid names are refused', async (t) => {
  const pair = roots(t);
  await same(pair, async (root) => {
    const dir = await root.getDirectoryHandle('names', { create: true });
    for (const name of NAMES) {
      const file = await dir.getFileHandle(name, { create: true });
      const w = await file.createWritable();
      await w.write(name);
      await w.close();
    }
    const seen = [];
    for await (const name of dir.keys()) seen.push(name);
    const texts = [];
    for (const name of NAMES) {
      texts.push(await (await (await dir.getFileHandle(name)).getFile()).text());
      assert.deepEqual(await root.resolve(await dir.getFileHandle(name)), ['names', name]);
    }
    return { seen: seen.sort(), texts };
  });
  for (const bad of ['', '.', '..', 'a/b', '/']) {
    await same(pair, (root) => root.getFileHandle(bad, { create: true }));
    await same(pair, (root) => root.getDirectoryHandle(bad, { create: true }));
    await same(pair, (root) => root.removeEntry(bad));
  }
});

test('lookups: kinds, misses and type mismatches', async (t) => {
  const pair = roots(t);
  await same(pair, async (root) => {
    await root.getDirectoryHandle('d', { create: true });
    await root.getFileHandle('f', { create: true });
    return listing(root);
  });
  await same(pair, (root) => root.getFileHandle('d'));
  await same(pair, (root) => root.getDirectoryHandle('f'));
  await same(pair, (root) => root.getFileHandle('missing'));
  await same(pair, (root) => root.getDirectoryHandle('missing'));
  await same(pair, (root) => root.removeEntry('missing'));
  await same(pair, async (root) => (await root.getDirectoryHandle('d')).kind);
  await same(pair, async (root) => (await root.getFileHandle('f')).name);
  await same(pair, async (root) => {
    const f = await (await root.getFileHandle('f')).getFile();
    return [f.size, f.name, typeof f.lastModified];
  });
});

test('removeEntry: a non-empty directory needs recursive, removed handles go stale', async (t) => {
  const pair = roots(t);
  const kept = new Map();
  await same(pair, async (root) => {
    const a = await root.getDirectoryHandle('a', { create: true });
    const b = await a.getDirectoryHandle('b', { create: true });
    const f = await b.getFileHandle('f', { create: true });
    const w = await f.createWritable();
    await w.write('x');
    await w.close();
    kept.set(root, { a, b, f });
    return listing(a);
  });
  await same(pair, (root) => root.removeEntry('a'));
  await same(pair, async (root) => listing(kept.get(root).b));
  await same(pair, (root) => root.removeEntry('a', { recursive: true }));
  await same(pair, (root) => root.getDirectoryHandle('a'));
  await same(pair, (root) => kept.get(root).b.getFileHandle('f'));
  await same(pair, (root) => kept.get(root).a.getDirectoryHandle('b', { create: true }));
  await same(pair, (root) => kept.get(root).f.getFile());
  await same(pair, async (root) => root.resolve(kept.get(root).f));
  await same(pair, async (root) => {
    const e = await root.getDirectoryHandle('e', { create: true });
    await root.removeEntry('e');
    return listing(root);
  });
  await same(pair, async (root) => {
    await root.getFileHandle('g', { create: true });
    await root.removeEntry('g', { recursive: true });
    return listing(root);
  });
});

test('writables: replace by default, keepExistingData, seek, truncate, params, abort', async (t) => {
  const pair = roots(t);
  const file = async (root) => root.getFileHandle('w', { create: true });
  const read = async (root) => bytes(root, 'w');
  await same(pair, async (root) => {
    const w = await (await file(root)).createWritable();
    await w.write('hello world');
    const before = await read(root);
    await w.close();
    return [before, await read(root)];
  });
  await same(pair, async (root) => {
    const w = await (await file(root)).createWritable();
    await w.write('HE');
    await w.close();
    return read(root);
  });
  await same(pair, async (root) => {
    const w = await (await file(root)).createWritable();
    await w.write('hello world');
    await w.close();
    const k = await (await file(root)).createWritable({ keepExistingData: true });
    await k.seek(6);
    await k.write('WORLD');
    await k.write({ type: 'write', position: 0, data: new TextEncoder().encode('J') });
    await k.write({ type: 'seek', position: 20 });
    await k.write(new Uint8Array([33]));
    await k.close();
    return read(root);
  });
  await same(pair, async (root) => {
    const k = await (await file(root)).createWritable({ keepExistingData: true });
    await k.truncate(3);
    await k.write({ type: 'write', position: 5, data: 'Z' });
    await k.write({ type: 'truncate', size: 9 });
    await k.close();
    return read(root);
  });
  await same(pair, async (root) => {
    const k = await (await file(root)).createWritable({ keepExistingData: true });
    await k.truncate(0);
    await k.truncate(4);
    await k.close();
    return read(root);
  });
  await same(pair, async (root) => {
    const k = await (await file(root)).createWritable({ keepExistingData: true });
    await k.write('lost');
    await k.abort();
    return read(root);
  });
  await same(pair, async (root) => {
    const k = await (await file(root)).createWritable();
    await k.write(new Blob(['blob ', new Uint8Array([1, 2, 3])]));
    await k.write(new Uint8Array([9, 8, 7]).buffer);
    await k.write(new DataView(new Uint8Array([4, 5, 6, 7]).buffer, 1, 2));
    await k.close();
    return read(root);
  });
  await same(pair, async (root) => {
    const source = await (await file(root)).getFile();
    const copy = await root.getFileHandle('copy', { create: true });
    const k = await copy.createWritable();
    await k.write(source);
    await k.close();
    return bytes(root, 'copy');
  });
});

test('ranged reads through File.slice across chunk boundaries', async (t) => {
  const pair = roots(t);
  const size = CHUNK_BYTES * 3 + 12345;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 7 + (i >> 9)) & 0xff;
  await same(pair, async (root) => {
    const w = await (await root.getFileHandle('r', { create: true })).createWritable();
    await w.write(data.subarray(0, 1000));
    await w.write(data.subarray(1000));
    await w.close();
    const f = await (await root.getFileHandle('r')).getFile();
    const cuts = [
      [0, 1],
      [CHUNK_BYTES - 3, CHUNK_BYTES + 3],
      [CHUNK_BYTES * 2, CHUNK_BYTES * 3 + 1],
      [size - 10, size + 10],
      [-20, -5],
      [5, 2],
    ];
    const out = [];
    for (const [a, b] of cuts) {
      const part = new Uint8Array(await f.slice(a, b).arrayBuffer());
      out.push([part.length, [...part.subarray(0, 8)], [...part.subarray(-8)]]);
    }
    const nested = new Uint8Array(
      await f
        .slice(100, 400000)
        .slice(CHUNK_BYTES - 200, CHUNK_BYTES)
        .arrayBuffer()
    );
    out.push([...nested.subarray(0, 16)]);
    out.push(f.size, (await f.text()).length > 0);
    return out;
  });
});

test('a File read after its file was written: memory keeps the snapshot, SQLite refuses like OPFS', async (t) => {
  const [[, memory], [, sqlite], [, behind]] = roots(t);
  const results = [];
  for (const root of [memory, sqlite, behind]) {
    const handle = await root.getFileHandle('s', { create: true });
    const w = await handle.createWritable();
    await w.write('one');
    await w.close();
    const old = await handle.getFile();
    const v = await handle.createWritable();
    await v.write('two!');
    await v.close();
    results.push(await outcome(async () => old.text()));
    results.push(await outcome(async () => (await handle.getFile()).text()));
  }
  assert.deepEqual(results, [
    { value: 'one' },
    { value: 'two!' },
    { error: 'NotReadableError' },
    { value: 'two!' },
    { error: 'NotReadableError' },
    { value: 'two!' },
  ]);
});

test('concurrent writers: each sees its own snapshot, the last to close wins', async (t) => {
  const pair = roots(t);
  const big = new Uint8Array(CHUNK_BYTES * 2 + 100).fill(7);
  await same(pair, async (root) => {
    const handle = await root.getFileHandle('c', { create: true });
    const w = await handle.createWritable();
    await w.write(big);
    await w.close();
    const a = await handle.createWritable({ keepExistingData: true });
    const b = await handle.createWritable({ keepExistingData: true });
    const c = await handle.createWritable();
    await a.write({ type: 'write', position: CHUNK_BYTES - 1, data: new Uint8Array([1, 1]) });
    await a.truncate(CHUNK_BYTES + 10);
    await b.write({ type: 'write', position: 5, data: new Uint8Array([2]) });
    await c.write('c');
    await a.close();
    const afterA = await bytes(root, 'c');
    await b.close();
    const afterB = await bytes(root, 'c');
    const d = await handle.createWritable({ keepExistingData: true });
    await c.close();
    const afterC = await bytes(root, 'c');
    await d.write({ type: 'write', position: 1, data: 'd' });
    await d.close();
    const sum = (list) => list.reduce((s, x, i) => (s + x * (i + 1)) % 1000000007, 0);
    return [
      afterA.length,
      sum(afterA),
      afterB.length,
      sum(afterB),
      afterC,
      (await bytes(root, 'c')).length,
      sum(await bytes(root, 'c')),
    ];
  });
});

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

for (const seed of [1813, 7, 42])
  test(`random writable sequences give the same bytes on both roots (seed ${seed})`, async (t) => {
    const pair = roots(t);
    const random = prng(seed);
    const int = (n) => Math.floor(random() * n);
    const span = CHUNK_BYTES * 3;
    const handles = await Promise.all(
      pair.map(([, root]) => root.getFileHandle('fuzz', { create: true }))
    );
    const open = [];
    for (let step = 0; step < 800; step++) {
      const roll = random();
      if (open.length === 0 || (roll < 0.15 && open.length < 3)) {
        const keepExistingData = random() < 0.7;
        open.push(await Promise.all(handles.map((h) => h.createWritable({ keepExistingData }))));
        continue;
      }
      const at = int(open.length);
      const writers = open[at];
      if (roll < 0.6) {
        const position = int(span);
        const data = new Uint8Array(1 + int(random() < 0.2 ? CHUNK_BYTES + 100 : 300)).fill(
          1 + int(250)
        );
        for (const w of writers) await w.write({ type: 'write', position, data });
      } else if (roll < 0.7) {
        const size = int(span);
        for (const w of writers) await w.truncate(size);
      } else if (roll < 0.75) {
        const position = int(span);
        for (const w of writers) await w.seek(position);
        const data = new Uint8Array(1 + int(50)).fill(int(256));
        for (const w of writers) await w.write(data);
      } else if (roll < 0.8) {
        for (const w of writers) await w.abort();
        open.splice(at, 1);
      } else {
        for (const w of writers) await w.close();
        open.splice(at, 1);
        const [m, ...others] = await Promise.all(pair.map(([, root]) => bytes(root, 'fuzz')));
        for (const s of others) {
          assert.equal(s.length, m.length, `size after step ${step}`);
          assert.ok(
            s.every((x, i) => x === m[i]),
            `bytes after step ${step}`
          );
        }
      }
    }
    for (const writers of open) for (const w of writers) await w.close();
    const [m, ...others] = await Promise.all(pair.map(([, root]) => bytes(root, 'fuzz')));
    for (const s of others) assert.deepEqual(s, m);
  });

test('move and resolve: files replace files, directories refuse to land on names, handles follow', async (t) => {
  const pair = roots(t);
  const kept = new Map();
  await same(pair, async (root) => {
    const a = await root.getDirectoryHandle('a', { create: true });
    const b = await root.getDirectoryHandle('b', { create: true });
    const f = await a.getFileHandle('f', { create: true });
    const g = await b.getFileHandle('g', { create: true });
    for (const [h, text] of [
      [f, 'eff'],
      [g, 'gee'],
    ]) {
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
    }
    kept.set(root, { a, b, f, g });
    await f.move(b, 'g');
    return [
      f.name,
      await listing(a),
      await listing(b),
      await root.resolve(f),
      await (await f.getFile()).text(),
    ];
  });
  await same(pair, (root) => kept.get(root).g.getFile());
  await same(pair, async (root) => {
    const { a, b } = kept.get(root);
    await a.getDirectoryHandle('sub', { create: true });
    return b.move(a, 'sub');
  });
  await same(pair, async (root) => {
    const { a, b } = kept.get(root);
    await root.getDirectoryHandle('c', { create: true });
    await b.move(a, 'moved');
    return [
      b.name,
      await root.resolve(b),
      await listing(root),
      await listing(a),
      await root.resolve(kept.get(root).f),
    ];
  });
  await same(pair, async (root) => {
    const { a } = kept.get(root);
    const d = await a.getDirectoryHandle('sub');
    const e = await root.getFileHandle('top', { create: true });
    await e.move(d, 'inside');
    return [await listing(d), await root.resolve(e), await d.resolve(e), await a.resolve(root)];
  });
  await same(pair, async (root) => {
    const { f } = kept.get(root);
    const d = await root.getDirectoryHandle('c');
    await f.move(d, 'c-file');
    const back = await d.getFileHandle('c-file');
    return [await root.resolve(back), await root.resolve(f), await (await back.getFile()).text()];
  });
});
