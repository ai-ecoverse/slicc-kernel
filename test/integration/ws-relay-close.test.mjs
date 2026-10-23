import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PACKAGE = JSON.stringify({
  name: 'wsclose',
  slicc: { commands: { wsclose: { abi: 'js', module: 'bin/wsclose.mjs' } } },
});

const PROGRAM = `const enc = new TextEncoder();
const dec = new TextDecoder();
export default async function main(ctx) {
  const c = await ctx.net.connect({ host: 'ws.example', port: 443, tls: {} });
  const w = c.writable.getWriter();
  await w.write(enc.encode('GET /peer HTTP/1.1\\r\\nHost: ws.example\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n'));
  const reader = c.readable.getReader();
  let buf = new Uint8Array(0);
  const more = async () => {
    const { value, done } = await reader.read();
    if (done) return false;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
    return true;
  };
  while (!dec.decode(buf).includes('\\r\\n\\r\\n')) if (!(await more())) break;
  const at = dec.decode(buf).indexOf('\\r\\n\\r\\n') + 4;
  const out = [dec.decode(buf.subarray(0, at)).split('\\r\\n')[0]];
  buf = buf.subarray(at);
  const mask = [1, 2, 3, 4];
  const body = [0x03, 0xe8];
  await w.write(new Uint8Array([0x88, 0x80 | body.length, ...mask, ...body.map((b, i) => b ^ mask[i % 4])]));
  for (;;) {
    while (buf.length < 2 || buf.length < 2 + (buf[1] & 0x7f)) if (!(await more())) break;
    if (buf.length < 2) break;
    const op = buf[0] & 0x0f;
    const len = buf[1] & 0x7f;
    const payload = buf.subarray(2, 2 + len);
    buf = buf.subarray(2 + len);
    if (op === 0x1) out.push('text ' + dec.decode(payload));
    else if (op === 0x8) {
      out.push('close ' + ((payload[0] << 8) | payload[1]) + ' ' + dec.decode(payload.subarray(2)));
      break;
    }
  }
  await ctx.write(1, out.join('\\n') + '\\n');
  await c.close();
}
`;

function peerTransport() {
  return {
    traits: {
      manualRedirects: false,
      encodedBodies: false,
      maxRequestBody: 1 << 20,
      websocket: true,
    },
    fetch: async () => ({
      status: 502,
      statusText: 'no',
      headers: [],
      body: (async function* () {})(),
      cancel: async () => {},
    }),
    async websocket() {
      const queue = [];
      let wake;
      let ended = false;
      let settle;
      const closed = new Promise((resolve) => (settle = resolve));
      return {
        protocol: '',
        buffered: 0,
        send() {},
        messages: (async function* () {
          for (;;) {
            while (queue.length) yield queue.shift();
            if (ended) return;
            await new Promise((r) => (wake = r));
          }
        })(),
        close() {
          setTimeout(() => {
            queue.push('sixteen bytes!!!');
            wake?.();
            setTimeout(() => {
              ended = true;
              wake?.();
              settle({ code: 4002, reason: 'peer done', wasClean: true });
            }, 50);
          }, 20);
        },
        closed,
      };
    },
  };
}

test('after the guest closes a relayed WebSocket, data the peer sends before its own close still reaches the guest, then the reply close (#1471)', async (t) => {
  const kernel = await createNodeKernel({ users: 'off', network: { transport: peerTransport() } });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/wsclose/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/wsclose/bin/wsclose.mjs', PROGRAM);
  const r = await kernel.run(['wsclose'], { cwd: '/' });
  assert.equal(
    String(r.stdout),
    'HTTP/1.1 101 Switching Protocols\ntext sixteen bytes!!!\nclose 4002 peer done\n',
    String(r.stderr)
  );
});
