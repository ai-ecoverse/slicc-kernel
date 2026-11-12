import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, startDev } from './cloudflare-fixture/dev.mjs';
import { bundledProcess } from './cloudflare-fixture/process-bundle.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));

test('a file written in one run is there after the Durable Object restarts', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'slicc-cf-persist-'));
  const scope = crypto.randomUUID();
  const process = await bundledProcess();
  try {
    const first = await startDev(config, { persist: state });
    if (first.skip) return t.skip(first.skip);
    try {
      const call = client(first, scope);
      assert.equal((await call('/kernel/boot', { process, persist: true })).status, 200);
      await call('/kernel/file-write', {
        path: '/root/kept.txt',
        data: 'written before the restart\n',
      });
      const r = await call('/kernel/run', { argv: ['fake', 'big', '/root/kept.txt'] });
      assert.equal(r.status, 0, r.stderr);
    } finally {
      await first.stop();
    }
    const second = await startDev(config, { persist: state });
    if (second.skip) return t.skip(second.skip);
    try {
      const call = client(second, scope);
      assert.equal((await call('/kernel/boot', { process, persist: true })).status, 200);
      const read = await call('/kernel/file-read', { path: '/root/kept.txt' });
      assert.equal(read.data, 'written before the restart\n');
      const r = await call('/kernel/run', { argv: ['fake', 'big', '/root/kept.txt'] });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^27 \d+/);
      const fresh = client(second, crypto.randomUUID());
      assert.equal((await fresh('/kernel/boot', { process, persist: true })).status, 200);
      assert.ok((await fresh('/kernel/file-read', { path: '/root/kept.txt' })).error);
    } finally {
      await second.stop();
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
