import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
import { client, startDev, until } from './cloudflare-fixture/dev.mjs';

const WAT = `(module
 (import "env" "sys" (func $sys (param i32) (result i32)))
 (memory (export "memory") 1)
 (func (export "run") (param $n i32) (result i32)
   (local $i i32) (local $acc i32)
   (block (loop
     (br_if 1 (i32.ge_u (local.get $i) (local.get $n)))
     (local.set $acc (i32.add (local.get $acc) (call $sys (local.get $i))))
     (local.set $i (i32.add (local.get $i) (i32.const 1)))
     (br 0)))
   (local.get $acc)))`;

function leb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

function tagged(base, tag) {
  const name = new TextEncoder().encode('slicc-image');
  const payload = new TextEncoder().encode(tag);
  const body = [...leb(name.length), ...name, ...payload];
  return new Uint8Array([...base, 0, ...leb(body.length), ...body]);
}

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
let dev;
let call;
let base;

before(async () => {
  dev = await startDev(config);
  if (dev.skip) return;
  call = client(dev);
  const wabt = await wabtInit();
  base = wabt.parseWat('probe.wat', WAT).toBinary({}).buffer;
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  if (!dev?.skip) return false;
  t.skip(dev.skip);
  return true;
};

async function image(tag) {
  const r = await call('/image', tagged(base, tag), { raw: true });
  return r.image;
}

const events = async (pid, query = '') =>
  (await call('/events', undefined, { query: `?pid=${pid}${query}` })).events;

async function waitFor(pid, type, count = 1) {
  return until(async () => {
    const list = (await events(pid)).filter((event) => event.type === type);
    return list.length >= count ? list : undefined;
  });
}

describe('Cloudflare process plumbing under wrangler dev', { concurrency: false }, () => {
  test('a process in a Dynamic Worker makes syscalls through the RPC link', async (t) => {
    if (skipped(t)) return;
    const id = await image('syscalls');
    const { pid } = await call('/spawn', { image: id });
    const [hello] = await waitFor(pid, 'hello');
    assert.equal(hello.tag, 'syscalls');
    await call('/cmd', { pid, cmd: { do: 'wasm', n: 1000 } });
    const [sum] = await waitFor(pid, 'sum');
    assert.equal(sum.sum, (1000 * 1001) / 2);
    assert.equal((await call('/events', undefined, { query: `?pid=${pid}` })).sys, 1000);
    t.diagnostic(`1000 wasm import calls answered by the DO in ${sum.ms} ms`);
    await call('/terminate', { pid });
  });

  test('a blocking read is answered later and a signal reaches the blocked process', async (t) => {
    if (skipped(t)) return;
    const id = await image('blocking');
    const { pid } = await call('/spawn', { image: id });
    await waitFor(pid, 'hello');
    await call('/cmd', { pid, cmd: { do: 'read' } });
    await waitFor(pid, 'read-blocked');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await events(pid)).filter((event) => event.type === 'read').length, 0);
    await call('/signal', { pid, sig: 2 });
    const [signalled] = await waitFor(pid, 'signalled');
    assert.deepEqual({ sig: signalled.sig, blocked: signalled.blocked }, { sig: 2, blocked: true });
    await call('/feed', { pid, data: 'typed later' });
    const [read] = await waitFor(pid, 'read');
    assert.equal(read.data, 'typed later');
    await call('/terminate', { pid });
  });

  test('values above 16 MiB are split in both directions', async (t) => {
    if (skipped(t)) return;
    const id = await image('big');
    const { pid } = await call('/spawn', { image: id });
    await waitFor(pid, 'hello');
    const size = 40 * 2 ** 20;
    await call('/cmd', { pid, cmd: { do: 'big', size } });
    const [big] = await until(
      async () => {
        const list = (await events(pid)).filter((event) => event.type === 'big');
        return list.length ? list : undefined;
      },
      { timeoutMs: 60_000 }
    );
    const [incoming] = (await events(pid)).filter((event) => event.type === 'big-in');
    assert.deepEqual(incoming, { type: 'big-in', size, last: 7 });
    assert.deepEqual(big, { type: 'big', sent: size, got: size + 5, last: 9, kind: 'Uint8Array' });
    await call('/terminate', { pid });
  });

  test('terminate ends the process, frees its isolate slot and two processes share one isolate', async (t) => {
    if (skipped(t)) return;
    const id = await image('shared');
    const first = (await call('/spawn', { image: id })).pid;
    const second = (await call('/spawn', { image: id })).pid;
    const [a] = await waitFor(first, 'hello');
    const [b] = await waitFor(second, 'hello');
    assert.equal(a.isolate, b.isolate);
    const before = await call('/gate');
    await call('/cmd', { pid: first, cmd: { do: 'read' } });
    await waitFor(first, 'read-blocked');
    await call('/terminate', { pid: first });
    await call('/terminate', { pid: second });
    const gate = await until(async () => {
      const now = await call('/gate');
      return now.active === before.active - 1 ? now : undefined;
    });
    assert.equal(gate.active, before.active - 1);
    const third = (await call('/spawn', { image: id })).pid;
    const [c] = await waitFor(third, 'hello');
    assert.equal(c.isolate, a.isolate);
    assert.equal(c.stats.ended, 2);
    assert.equal(c.stats.closedCalls >= 1, true);
    await call('/terminate', { pid: third });
  });

  test('eleven distinct images do not break the isolate limit', async (t) => {
    if (skipped(t)) return;
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await image(`limit-${i}`));
    await until(async () => (await call('/gate')).active === 0);
    const pids = [];
    for (const id of ids.slice(0, 11)) pids.push((await call('/spawn', { image: id })).pid);
    for (const pid of pids.slice(0, 8)) await waitFor(pid, 'hello');
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const pid of pids.slice(8)) {
      assert.equal(
        (await events(pid)).some((event) => event.type === 'hello'),
        false
      );
    }
    assert.equal((await call('/gate')).active, 8);
    for (const pid of pids.slice(0, 3)) await call('/terminate', { pid });
    for (const pid of pids.slice(8)) await waitFor(pid, 'hello');
    const gate = await call('/gate');
    assert.equal(gate.active, 8);
    assert.equal(gate.peak, 8);
    for (const pid of pids.slice(3)) {
      await call('/cmd', { pid, cmd: { do: 'wasm', n: 10 } });
      await waitFor(pid, 'sum');
    }
    const late = (await call('/spawn', { image: ids[11] })).pid;
    const [failed] = await waitFor(late, 'failed');
    assert.equal(failed.code, 'EAGAIN');
    for (const pid of pids.slice(3)) await call('/terminate', { pid });
    await until(async () => (await call('/gate')).active === 0);
  });
});
