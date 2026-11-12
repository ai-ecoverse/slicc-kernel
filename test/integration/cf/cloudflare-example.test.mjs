import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPO, startDev } from './cloudflare-fixture/dev.mjs';

const config = fileURLToPath(
  new URL('../../../examples/cloudflare/wrangler.json', import.meta.url)
);
export const MILESTONE =
  'echo a | cat; x=$(uname); ls / | head -3; for i in 1 2 3; do echo $i; done | wc -l';

const remote = { url: process.env.SLICC_CF_EXAMPLE_URL, key: process.env.SLICC_CF_EXAMPLE_KEY };
let state;
let dev;
let processHost;

function request(target, path, body, key = target.key) {
  return fetch(`${target.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: key ? { authorization: `Bearer ${key}` } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function run(target, argv, extra = {}) {
  const response = await request(target, '/run', { argv, ...extra });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.status, text: text.slice(0, 500) };
  }
}

before(async () => {
  const sources = await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({}));
  processHost = sources.PROCESS_SOURCE;
  state = await mkdtemp(join(tmpdir(), 'slicc-cf-example-'));
  dev = await startDev(config, { remote, persist: join(state, 'state') });
});

after(async () => {
  await dev?.stop?.();
  await rm(state, { recursive: true, force: true });
});

const skipped = (t) => {
  if (!dev?.skip) return false;
  t.skip(dev.skip);
  return true;
};

describe('the example Worker', { concurrency: false }, () => {
  test('every route is behind the key', async (t) => {
    if (skipped(t)) return;
    for (const [path, body] of [
      ['/boot', undefined],
      ['/run', { argv: ['true'] }],
      ['/nowhere', undefined],
    ]) {
      assert.equal((await request(dev, path, body, '')).status, 403);
      assert.equal((await request(dev, path, body, 'wrong')).status, 403);
    }
  });

  test('the Durable Object boots the kernel and installs bash and coreutils once', async (t) => {
    if (skipped(t)) return;
    const first = await (await request(dev, '/boot')).json();
    assert.equal(first.cold, true);
    if (!remote.url) assert.equal(first.installed, 3);
    t.diagnostic(`cold boot with install: ${first.bootMs} ms`);
    const again = await (await request(dev, '/boot')).json();
    assert.equal(again.cold, false);
    if (remote.url) return;
    await dev.stop();
    dev = await startDev(config, { persist: join(state, 'state') });
    if (dev.skip) return t.skip(dev.skip);
    const restarted = await (await request(dev, '/boot')).json();
    assert.equal(restarted.cold, true);
    assert.equal(restarted.installed, 0);
    t.diagnostic(`cold boot on the persisted root: ${restarted.bootMs} ms`);
  });

  test('POST /run runs bash with coreutils', async (t) => {
    if (skipped(t)) return;
    if (!processHost) return t.skip('dist/async-process.js is not built yet (workstream B2)');
    const hi = await run(dev, ['bash', '-c', 'echo hi']);
    assert.deepEqual(
      { status: hi.status, stdout: hi.stdout, stderr: hi.stderr },
      {
        status: 0,
        stdout: 'hi\n',
        stderr: '',
      }
    );
    const r = await run(dev, ['bash', '-c', MILESTONE]);
    assert.equal(r.status, 0, JSON.stringify(r));
    assert.match(r.stdout, /^a\n(\S+\n){3}3\n$/);
    assert.equal(r.stderr, '');
    const rg = await run(dev, [
      'bash',
      '-c',
      'mkdir -p /tmp/t; echo needle > /tmp/t/a; echo hay > /tmp/t/b; rg -l needle /tmp/t',
    ]);
    assert.deepEqual({ status: rg.status, stdout: rg.stdout }, { status: 0, stdout: '/tmp/t/a\n' });
    const stdin = await run(dev, ['cat'], { stdin: 'from stdin\n', cwd: '/' });
    assert.equal(stdin.stdout, 'from stdin\n');
  });
});
