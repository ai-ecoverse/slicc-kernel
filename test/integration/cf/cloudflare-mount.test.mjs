import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
let dev;
let processHost;
let call;
let run;

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (dev.skip) return;
  call = client(dev);
  const booted = await call('/kernel/boot', { commands: ['/image/node_modules'] });
  assert.equal(booted.status, 200, JSON.stringify(booted));
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    const to = `/node_modules/@ai-ecoverse/${name}`;
    await uploadTree(call, join(MODULES, name), to, programs, '/kernel/tree');
  }
  run = async (script) => {
    const r = await call('/kernel/run', { argv: ['bash', '-c', script] });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, thrown: r.thrown };
  };
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built yet (workstream B2)';
  if (why) t.skip(why);
  return Boolean(why);
};

describe('a file system the Durable Object serves itself', { concurrency: false }, () => {
  test('nothing runs before the mount: the root has no packages', async (t) => {
    if (skipped(t)) return;
    const r = await run('echo hi');
    assert.notEqual(r.status, 0, JSON.stringify(r));
  });

  test('programs run from a read-only in-process mount that is a command root', async (t) => {
    if (skipped(t)) return;
    const mounted = await call('/kernel/mount-tree', { target: '/image' });
    assert.deepEqual(
      { type: mounted.type, target: mounted.target, state: mounted.state },
      { type: 'tree', target: '/image', state: 'ok' }
    );
    const r = await run(
      'echo hi | cat; type ls; ls /image/node_modules/@ai-ecoverse; wc -c < /image/node_modules/@ai-ecoverse/wasm-bash/package.json; while read -r source target type options rest; do [ "$target" = /image ] && echo "$source $type $options"; done < /proc/mounts'
    );
    assert.equal(r.stderr, '');
    assert.match(
      r.stdout,
      /^hi\nls is \/usr\/bin\/ls\nwasm-bash\nwasm-coreutils\n\d+\nfixture tree ro\n$/,
      JSON.stringify(r)
    );
    const { reads } = await call('/kernel/tree-reads', {});
    assert.ok(reads.includes('/node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm'), reads.join());
    assert.ok(reads.includes('/node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils.wasm'));
  });

  test('the mount refuses every change, and the root beside it takes them', async (t) => {
    if (skipped(t)) return;
    const r = await run(
      'touch /image/new; echo touch=$?; echo x > /image/node_modules/@ai-ecoverse/wasm-bash/package.json; echo write=$?; rm /image/node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm; echo rm=$?; mkdir /image/d; echo mkdir=$?; echo y > /tmp/beside && cat /tmp/beside'
    );
    assert.equal(r.stdout, 'touch=1\nwrite=1\nrm=1\nmkdir=1\ny\n', JSON.stringify(r));
    assert.match(r.stderr, /Read-only file system/);
    assert.equal((await run('echo still')).stdout, 'still\n');
  });
});
