import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PACKAGE = JSON.stringify({
  name: 'strictws',
  slicc: { commands: { strictws: { abi: 'js', module: 'bin/strictws.mjs' } } },
});

const PROGRAM = `const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const bytes = (...parts) => {
  const chunks = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};
async function accept(key) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key + GUID));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
async function serveOne(listener, echoes) {
  const c = await listener.accept();
  const reader = c.readable.getReader();
  const writer = c.writable.getWriter();
  let head = '';
  while (!head.includes('\\r\\n\\r\\n')) {
    const next = await reader.read();
    if (next.done) return;
    head += new TextDecoder('latin1').decode(next.value);
  }
  const path = head.split(' ')[1];
  const key = /sec-websocket-key: (.*)\\r\\n/i.exec(head)[1];
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket'];
  if (path !== '/noconn') lines.push('Connection: Upgrade');
  if (path === '/ext') lines.push('Sec-WebSocket-Extensions: permessage-deflate');
  lines.push('Sec-WebSocket-Accept: ' + (await accept(key)));
  await writer.write(new TextEncoder().encode(lines.join('\\r\\n') + '\\r\\n\\r\\n'));
  if (path === '/masked') await writer.write(bytes([0x81, 0x82, 1, 2, 3, 4, 0x68 ^ 1, 0x69 ^ 2]));
  if (path === '/rsv') await writer.write(bytes([0xc1, 2], 'hi'));
  if (path === '/bigping') await writer.write(bytes([0x89, 126, 0, 126], new Uint8Array(126)));
  if (path === '/drop') await new Promise((r) => setTimeout(r, 50));
  if (path === '/close') {
    await writer.write(bytes([0x88, 5, 0x0f, 0xa1], 'bye'));
    const next = await reader.read();
    if (!next.done) {
      const f = next.value;
      echoes.push((f[0] & 0x0f) + ':' + (((f[2] ^ f[6]) << 8) | (f[3] ^ f[7])));
    }
  }
  await c.close();
}
async function one(ctx, port, path) {
  const events = [];
  try {
    const ws = await ctx.websocket('ws://127.0.0.1:' + port + path);
    events.push('open');
    const reader = ws.readable.getReader();
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true }));
      if (next.done) break;
      events.push('message ' + next.value);
    }
    const closed = await ws.closed;
    events.push('close ' + closed.code + ' ' + JSON.stringify(closed.reason) + ' ' + closed.wasClean);
  } catch (err) {
    events.push('error ' + (err.cause?.code ?? err.code));
  }
  return path + ': ' + events.join(', ');
}
export default async function main(ctx) {
  const port = 7300;
  const echoes = [];
  const out = [];
  for (const path of ['/masked', '/rsv', '/bigping', '/noconn', '/ext', '/drop', '/close']) {
    const listener = await ctx.net.listen({ port });
    const served = serveOne(listener, echoes).catch(() => undefined);
    out.push(await one(ctx, port, path));
    await served;
    await listener.close();
  }
  out.push('echoed ' + echoes.join(','));
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

test('ctx.websocket holds an in-kernel server to RFC 6455, as undici does, and answers its close', {
  timeout: 60_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/strictws/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/strictws/bin/strictws.mjs', PROGRAM);
  const got = await kernel.run(['strictws'], { cwd: '/' });
  assert.equal(got.stderr, '');
  assert.equal(
    got.stdout,
    [
      '/masked: open, close 1006 "" false',
      '/rsv: open, close 1006 "" false',
      '/bigping: open, close 1006 "" false',
      '/noconn: error EPROTO',
      '/ext: error EPROTO',
      '/drop: open, close 1006 "" false',
      '/close: open, close 4001 "bye" true',
      'echoed 8:4001',
      '',
    ].join('\n')
  );
});
