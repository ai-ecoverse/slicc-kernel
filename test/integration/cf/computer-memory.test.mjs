import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { computerWith, run } from './computer-harness.mjs';

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc');

const MOUNT = '/workspace';
const MiB = 1024 * 1024;
const SIZES = { small: 4096, big: 32 * MiB, bigger: 64 * MiB };
const BOUND = 16 * MiB;

function patterned(size) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(65536, size - sent));
      for (let i = 0; i < chunk.length; i += 256) chunk[i] = (sent / 65536 + i) & 255;
      chunk.fill((sent / 65536) & 255, 1, 7);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
}

function live() {
  gc();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

const probe = { base: 0, peak: 0 };

function sampled() {
  probe.peak = Math.max(probe.peak, live());
}

function sampledStream(source) {
  const reader = source.getReader();
  return new ReadableStream({
    async pull(controller) {
      sampled();
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function probing(fs) {
  return new Proxy(fs, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'readFile') {
        return async (...args) => {
          sampled();
          const result = await value.apply(target, args);
          return result instanceof ReadableStream ? sampledStream(result) : result;
        };
      }
      if (key === 'writeFile') {
        return (path, content, ...rest) =>
          value.call(
            target,
            path,
            content instanceof ReadableStream ? sampledStream(content) : content,
            ...rest
          );
      }
      return value.bind(target);
    },
  });
}

async function peakOf(work) {
  probe.base = live();
  probe.peak = probe.base;
  const result = await work();
  sampled();
  return { result, growth: probe.peak - probe.base };
}

describe('a large file inside the mount', () => {
  let computer;
  let ws;
  before(async () => {
    computer = await computerWith({ wrapFs: probing });
    ws = computer.workspace;
    await ws.fs.mkdir(`${MOUNT}/large`, { recursive: true });
    for (const [name, size] of Object.entries(SIZES)) {
      await ws.fs.writeFile(`${MOUNT}/large/${name}`, patterned(size));
    }
  });
  after(() => computer.close());

  for (const [label, sized, copy] of [
    ['cp', true, (from, to) => `cp large/${from} large/${to}`],
    ['dd', true, (from, to) => `dd if=large/${from} of=large/${to} bs=256K status=none`],
    ['cat >', false, (from, to) => `cat large/${from} > large/${to}`],
  ]) {
    it(`is copied by ${label} with peak memory bounded`, async () => {
      const growth = {};
      for (const name of Object.keys(SIZES)) {
        const copied = await peakOf(() => run(ws, copy(name, 'copy')));
        assert.equal(copied.result.exitCode, 0, copied.result.stderr);
        assert.equal((await ws.fs.stat(`${MOUNT}/large/copy`)).size, SIZES[name]);
        if (name === 'big') {
          const sums = await run(
            ws,
            'sha256sum large/big large/copy | cut -d" " -f1 | uniq | wc -l'
          );
          assert.equal(sums.stdout.trim(), '1');
        }
        await ws.fs.rm(`${MOUNT}/large/copy`);
        growth[name] = copied.growth;
      }
      const shown = Object.entries(growth)
        .map(([name, bytes]) => `${name} ${(bytes / MiB).toFixed(1)} MiB`)
        .join(', ');
      assert.ok(growth.bigger - growth.big < BOUND, `peak grew with the file: ${shown}`);
      if (sized) assert.ok(growth.big - growth.small < BOUND, `peak near the file size: ${shown}`);
    });
  }
});
