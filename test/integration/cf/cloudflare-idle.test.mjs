import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev, until } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
let dev;
let processHost;

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
});

after(async () => {
  await dev?.stop?.();
});

test('a kernel with no process running leaves no timer pending, so its Durable Object can go idle', async (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built';
  if (why) return t.skip(why);
  const call = client(dev);
  assert.equal((await call('/kernel/boot', { persist: true })).status, 200);
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    await uploadTree(call, join(MODULES, name), `/node_modules/@ai-ecoverse/${name}`, programs);
  }
  const ran = await call('/kernel/run', {
    argv: [
      'bash',
      '-c',
      'echo hi | cat > /root/f; (sleep 0.2; echo late >> /root/f) & wait; cat /root/f',
    ],
  });
  assert.equal(ran.stdout, 'hi\nlate\n', JSON.stringify(ran).slice(0, 400));
  let seen;
  const quiet = await until(
    async () => {
      seen = (await call('/kernel/timers', {})).pending;
      return seen.length === 0 ? true : undefined;
    },
    { timeoutMs: 5000, everyMs: 100 }
  ).catch(() => false);
  assert.ok(quiet, `timers still pending: ${JSON.stringify(seen)}`);
  const again = await call('/kernel/run', { argv: ['bash', '-c', 'cat /root/f'] });
  assert.equal(again.stdout, 'hi\nlate\n');
});
