import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
const PACKAGES = ['wasm-bash', 'wasm-coreutils', 'wasm-curl'];
const GONE = 'the browser went away';
let dev;
let processHost;
let call;

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (dev.skip) return;
  call = client(dev);
  assert.equal((await call('/kernel/boot', { cdp: true })).status, 200);
  for (const name of PACKAGES) {
    await uploadTree(call, join(MODULES, name), `/node_modules/@ai-ecoverse/${name}`, programs);
  }
  for (const [runtime, mode] of [
    ['firefox', 'reject'],
    ['webkit', 'close'],
    ['chromium', 'answer'],
  ]) {
    assert.equal((await call('/kernel/serve-cdp', { runtime, mode })).ok, true);
  }
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/cloudflare-sources.js has no process host';
  if (why) t.skip(why);
  return Boolean(why);
};

async function bash(script) {
  const started = Date.now();
  const r = await call('/kernel/run', { argv: ['bash', '-c', `set -o pipefail; ${script}`] });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return { stdout: r.stdout, ms: Date.now() - started };
}

const http = (path) => `'http://127.0.0.1:9222${path}'`;

async function upgrade(runtime) {
  const { stdout, ms } = await bash(
    `curl -sS -i -m 8 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "\${SLICC_CDP_URL/ws:/http:}?runtime=${runtime}" | od -An -tx1 -v`
  );
  const bytes = Uint8Array.from(stdout.trim().split(/\s+/), (h) => Number.parseInt(h, 16));
  const text = new TextDecoder('latin1').decode(bytes);
  const split = text.indexOf('\r\n\r\n') + 4;
  return { head: text.slice(0, split), rest: bytes.slice(split), ms };
}

function closeFrame(code, reason) {
  const payload = new TextEncoder().encode(reason);
  return Uint8Array.from([0x88, payload.length + 2, code >> 8, code & 0xff, ...payload]);
}

function assertRefused(answer, runtime) {
  assert.match(answer.head, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
  const body = new TextDecoder().decode(answer.rest);
  assert.equal(body, `CDP host: no browser for runtime ${runtime}\n`);
  assert.ok(answer.ms < 8000, `answered in ${answer.ms} ms`);
}

function assertClosed(answer) {
  assert.match(answer.head, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.deepEqual([...answer.rest], [...closeFrame(1011, GONE)]);
  assert.ok(answer.ms < 8000, `answered in ${answer.ms} ms`);
}

describe('a CDP host in a Durable Object that fails answers the program', {
  concurrency: false,
}, () => {
  test('a client-served hook (serveCdp) that refuses gives 502 with its message', async (t) => {
    if (skipped(t)) return;
    assertRefused(await upgrade('firefox'), 'firefox');
    const list = await bash(
      `curl -sS -m 8 -w ' %{http_code}' ${http('/json/list?runtime=firefox')}`
    );
    assert.equal(list.stdout, 'CDP host: no browser for runtime firefox\n 502');
  });

  test('a client-served connection that closes at once gives a 1011 close frame with its reason', async (t) => {
    if (skipped(t)) return;
    assertClosed(await upgrade('webkit'));
    const list = await bash(
      `curl -sS -m 8 -w ' %{http_code}' ${http('/json/list?runtime=webkit')}`
    );
    assert.equal(list.stdout, `the CDP host closed: ${GONE}\n 502`);
  });

  test('a client-served host that answers still lists its targets', async (t) => {
    if (skipped(t)) return;
    const list = await bash(`curl -sS -m 8 ${http('/json/list?runtime=chromium')}`);
    assert.deepEqual(JSON.parse(list.stdout), [
      { description: '', id: 't1', title: 'fixture', type: 'page', url: 'about:blank' },
    ]);
  });

  test("createCloudflareKernel's cdp hook serves programs, and refuses or closes the same way", async (t) => {
    if (skipped(t)) return;
    const list = await bash(`curl -sS -m 8 ${http('/json/list')}`);
    assert.equal(JSON.parse(list.stdout)[0].id, 't1');
    assertRefused(await upgrade('refuse'), 'refuse');
    assertClosed(await upgrade('gone'));
  });
});
