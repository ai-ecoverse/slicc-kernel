import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const GONE = 'the browser went away';
const TARGETS = [{ targetId: 't1', type: 'page', title: 'fixture', url: 'about:blank' }];

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

function fakeBrowser(modeOf) {
  return async (request) => {
    const mode = modeOf(request.runtime);
    if (mode === 'reject') throw new Error(`no browser for runtime ${request.runtime}`);
    let onclose = null;
    const gone = () => onclose?.(GONE);
    return {
      onmessage: null,
      get onclose() {
        return onclose;
      },
      set onclose(next) {
        onclose = next;
        if (next && mode === 'close') gone();
      },
      send(message) {
        if (mode === 'close') return gone();
        const { id } = JSON.parse(message);
        queueMicrotask(() =>
          this.onmessage?.(JSON.stringify({ id, result: { targetInfos: TARGETS } }))
        );
      },
      close() {},
    };
  };
}

let kernel;
let client;

before(async () => {
  const modes = { refuse: 'reject', gone: 'close' };
  kernel = await createNodeKernel({ cdp: fakeBrowser((runtime) => modes[runtime] ?? 'answer') });
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-curl']) await install(kernel, name);
  client = await attachKernel(await kernel.connect());
  await client.serveCdp(
    fakeBrowser(() => 'reject'),
    { runtime: 'firefox' }
  );
  await client.serveCdp(
    fakeBrowser(() => 'close'),
    { runtime: 'webkit' }
  );
});

after(() => {
  client?.close();
  kernel?.terminate();
});

async function bash(script) {
  const started = Date.now();
  const r = await kernel.run(['bash', '-c', `set -o pipefail; ${script}`], { cwd: '/' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return { stdout: r.stdout, ms: Date.now() - started };
}

async function upgrade(runtime) {
  const { stdout, ms } = await bash(
    `curl -sS -i -m 8 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "\${SLICC_CDP_URL/ws:/http:}?runtime=${runtime}" | od -An -tx1 -v`
  );
  const bytes = Uint8Array.from(stdout.trim().split(/\s+/), (h) => Number.parseInt(h, 16));
  const text = new TextDecoder('latin1').decode(bytes);
  const split = text.indexOf('\r\n\r\n') + 4;
  assert.ok(ms < 8000, `answered in ${ms} ms`);
  return { head: text.slice(0, split), rest: [...bytes.slice(split)] };
}

function closeFrame(code, reason) {
  const payload = new TextEncoder().encode(reason);
  return [0x88, payload.length + 2, code >> 8, code & 0xff, ...payload];
}

for (const [who, refusing, closing] of [
  ['a client-served hook (serveCdp)', 'firefox', 'webkit'],
  ["createNodeKernel's cdp hook", 'refuse', 'gone'],
]) {
  test(`${who} that refuses gives the program 502 with its message`, async () => {
    const { head, rest } = await upgrade(refusing);
    assert.match(head, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
    assert.equal(
      new TextDecoder().decode(Uint8Array.from(rest)),
      `CDP host: no browser for runtime ${refusing}\n`
    );
  });

  test(`${who} whose connection closes at once gives the program a 1011 close frame`, async () => {
    const { head, rest } = await upgrade(closing);
    assert.match(head, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.deepEqual(rest, closeFrame(1011, GONE));
    const list = await bash(
      `curl -sS -m 8 -w ' %{http_code}' 'http://127.0.0.1:9222/json/list?runtime=${closing}'`
    );
    assert.equal(list.stdout, `the CDP host closed: ${GONE}\n 502`);
  });
}
