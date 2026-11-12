import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev } from './cloudflare-fixture/dev.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const RG = join(REPO, 'node_modules/@ai-ecoverse/wasi-ripgrep');
let dev;
let call;
let processHost;

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (!dev.skip) call = client(dev);
});

after(async () => {
  await dev?.stop?.();
});

test('a WASI program runs in a Dynamic Worker on the built async process host', async (t) => {
  if (!processHost) return t.skip('dist/async-process.js is not built yet (workstream B2)');
  if (dev.skip) return t.skip(dev.skip);
  assert.equal((await call('/kernel/boot', {})).status, 200);
  for (const file of ['package.json', 'bin/rg.wasm']) {
    const path = `/node_modules/@ai-ecoverse/wasi-ripgrep/${file}`;
    const r = await call('/kernel/upload', await readFile(join(RG, file)), {
      raw: true,
      query: `?path=${path}`,
    });
    assert.equal(r.status, 200);
  }
  await call('/kernel/file-write', { path: '/root/a.txt', data: 'hello\nworld\n' });
  const found = await call('/kernel/run', { argv: ['rg', 'wor', '/root/a.txt'] });
  assert.deepEqual(
    { status: found.status, stdout: found.stdout, stderr: found.stderr },
    {
      status: 0,
      stdout: 'world\n',
      stderr: '',
    }
  );
  const missing = await call('/kernel/run', { argv: ['rg', 'x', '/nope'] });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /No such file or directory/);
});
