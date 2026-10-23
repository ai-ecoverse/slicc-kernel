import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PACKAGE = JSON.stringify({
  name: 'tlsprobe',
  slicc: { commands: { tlsprobe: { abi: 'js', module: 'bin/tlsprobe.mjs' } } },
});

const PROGRAM = `const enc = new TextEncoder();
const dec = new TextDecoder();
async function readAll(c) {
  const reader = c.readable.getReader();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += dec.decode(value);
  }
}
async function readUntil(reader, test) {
  let bytes = new Uint8Array(0);
  while (!test(bytes)) {
    const { value, done } = await reader.read();
    if (done) break;
    const next = new Uint8Array(bytes.length + value.length);
    next.set(bytes);
    next.set(value, bytes.length);
    bytes = next;
  }
  return bytes;
}
export default async function main(ctx) {
  const [mode] = ctx.argv.slice(1);
  const say = (line) => ctx.write(1, line + '\\n');
  if (mode === 'get') {
    const c = await ctx.net.connect({ host: 'api.example', port: 443, tls: { servername: 'api.example', alpn: ['h2', 'http/1.1'], rejectUnauthorized: false } });
    await say(JSON.stringify(c.tls) + ' ' + c.remote.host + ':' + c.remote.port);
    const w = c.writable.getWriter();
    await w.write(enc.encode('GET /v1/thing?x=1 HTTP/1.1\\r\\nHost: api.example\\r\\nAuthorization: Bearer SEALED_PLACEHOLDER_1\\r\\nConnection: close\\r\\n\\r\\n'));
    const text = await readAll(c);
    await say(text.split('\\r\\n')[0] + ' | ' + (text.includes('hello /v1/thing') ? 'hello /v1/thing' : text));
    const r = await ctx.fetch('https://api.example/v1/thing?x=1', { headers: { authorization: 'Bearer SEALED_PLACEHOLDER_1' } });
    await say('fetch ' + r.status + ' ' + (await r.text()));
  } else if (mode === 'port') {
    const c = await ctx.net.connect({ host: 'api.example', port: 8443, tls: {} });
    const w = c.writable.getWriter();
    await w.write(enc.encode('GET / HTTP/1.1\\r\\nHost: api.example:8443\\r\\nConnection: close\\r\\n\\r\\n'));
    await say((await readAll(c)).split('\\r\\n')[0]);
  } else if (mode === 'hostloop') {
    const c = await ctx.net.connect({ host: 'host.slicc.internal', port: 8443, tls: {} });
    const w = c.writable.getWriter();
    await w.write(enc.encode('GET /h HTTP/1.1\\r\\nHost: host.slicc.internal:8443\\r\\nConnection: close\\r\\n\\r\\n'));
    await say((await readAll(c)).split('\\r\\n')[0]);
  } else if (mode === 'ws') {
    const c = await ctx.net.connect({ host: 'ws.example', port: 443, tls: {} });
    const w = c.writable.getWriter();
    await w.write(enc.encode('GET /chat HTTP/1.1\\r\\nHost: ws.example\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n'));
    const reader = c.readable.getReader();
    const head = dec.decode(await readUntil(reader, (b) => dec.decode(b).includes('\\r\\n\\r\\n')));
    await say(head.split('\\r\\n')[0]);
    const mask = [1, 2, 3, 4];
    const payload = enc.encode('hi');
    const frame = new Uint8Array([0x81, 0x80 | payload.length, ...mask, ...payload.map((b, i) => b ^ mask[i % 4])]);
    await w.write(frame);
    const back = await readUntil(reader, (b) => b.length >= 2 && b.length >= 2 + (b[1] & 0x7f));
    await say('echo ' + dec.decode(back.subarray(2, 2 + (back[1] & 0x7f))));
    await c.close();
  } else if (mode === 'refused') {
    for (const [what, options] of [
      ['ca', { host: 'api.example', port: 443, tls: { ca: 'PEM' } }],
      ['alpn', { host: 'api.example', port: 443, tls: { alpn: ['h2'] } }],
      ['smtps', { host: 'mail.example', port: 465, tls: {} }],
      ['imaps', { host: 'mail.example', port: 993, tls: {} }],
      ...['localhost', 'app.localhost', '127.0.0.1', '127.9.9.9', '0.0.0.0', '::1', '[::1]'].map((host) => [host, { host, port: 443, tls: {} }]),
      ['sni 127.0.0.1', { host: 'api.example', port: 443, tls: { servername: '127.0.0.1' } }],
      ['host 127.0.0.1', { host: '127.0.0.1', port: 443, tls: { servername: 'api.example' } }],
    ]) {
      await ctx.net.connect(options).then(() => say(what + ' connected'), (e) => say(what + ' ' + e.code));
    }
    const c = await ctx.net.connect({ host: 'mail.example', port: 443, tls: {} });
    const w = c.writable.getWriter();
    await w.write(enc.encode('EHLO client.example\\r\\n'));
    await say('smtp over https ' + (await readAll(c)).split('\\r\\n')[0]);
  }
}
`;

function fakeTransport() {
  const seen = [];
  return {
    seen,
    traits: {
      manualRedirects: false,
      encodedBodies: false,
      maxRequestBody: 1 << 20,
      websocket: true,
    },
    async fetch(req) {
      const headers = Object.fromEntries(req.headers.map(([k, v]) => [k.toLowerCase(), v]));
      seen.push({ url: req.url, method: req.method, authorization: headers.authorization });
      const body = new TextEncoder().encode(`hello ${new URL(req.url).pathname}`);
      return {
        status: 200,
        statusText: 'OK',
        headers: [
          ['content-type', 'text/plain'],
          ['content-length', String(body.length)],
        ],
        body: (async function* () {
          yield body;
        })(),
        cancel: async () => {},
      };
    },
    async websocket(req) {
      seen.push({ url: req.url, ws: true });
      let push;
      const queue = [];
      let closed;
      const done = new Promise((resolve) => (closed = resolve));
      return {
        protocol: '',
        buffered: 0,
        send(data) {
          queue.push(data);
          push?.();
        },
        messages: (async function* () {
          for (;;) {
            while (queue.length) yield queue.shift();
            await new Promise((r) => (push = r));
          }
        })(),
        close(code = 1000, reason = '') {
          closed({ code, reason, wasClean: true });
        },
        closed: done,
      };
    },
  };
}

async function booted(t) {
  const transport = fakeTransport();
  const kernel = await createNodeKernel({ users: 'off', network: { transport } });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/tlsprobe/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/tlsprobe/bin/tlsprobe.mjs', PROGRAM);
  const run = (mode) => kernel.run(['tlsprobe', mode], { cwd: '/' });
  return { transport, run };
}

test('ctx.net.connect with tls carries HTTP/1.1 to the transport as ctx.fetch does, a sealed placeholder header included, and says the transport verified it (#914)', async (t) => {
  const { transport, run } = await booted(t);
  const got = await run('get');
  assert.equal(got.stderr, '');
  assert.equal(
    got.stdout,
    '{"path":"transport","substitutes":true,"protocol":"transport","alpnProtocol":"http/1.1","authorized":true,"servername":"api.example"} api.example:443\n' +
      'HTTP/1.1 200 OK | hello /v1/thing\n' +
      'fetch 200 hello /v1/thing\n'
  );
  assert.deepEqual(transport.seen, [
    {
      url: 'https://api.example/v1/thing?x=1',
      method: 'GET',
      authorization: 'Bearer SEALED_PLACEHOLDER_1',
    },
    {
      url: 'https://api.example/v1/thing?x=1',
      method: 'GET',
      authorization: 'Bearer SEALED_PLACEHOLDER_1',
    },
  ]);
  assert.equal((await run('port')).stdout, 'HTTP/1.1 200 OK\n');
  assert.equal(transport.seen.at(-1).url, 'https://api.example:8443/');
});

test('ctx.net.connect with tls upgrades to a WebSocket through the transport, as wss:// (#914)', async (t) => {
  const { transport, run } = await booted(t);
  assert.deepEqual(await run('ws'), {
    status: 0,
    stdout: 'HTTP/1.1 101 Switching Protocols\necho hi\n',
    stderr: '',
  });
  assert.deepEqual(transport.seen, [{ url: 'wss://ws.example/chat', ws: true }]);
});

test('ctx.net.connect with tls refuses a custom ca, an alpn list without http/1.1, well-known non-HTTP TLS ports and the kernel loopback at connect (never sent to the transport; localhost and 127.x dial the kernel loopback since #1401), and answers non-HTTP bytes with 400 and a close (#914)', async (t) => {
  const { transport, run } = await booted(t);
  assert.deepEqual(await run('refused'), {
    status: 0,
    stdout:
      'ca ENOTSUP\nalpn EPROTONOSUPPORT\nsmtps EPROTONOSUPPORT\nimaps EPROTONOSUPPORT\n' +
      'localhost ECONNREFUSED\napp.localhost ENOTSUP\n127.0.0.1 ECONNREFUSED\n127.9.9.9 ECONNREFUSED\n0.0.0.0 ENOTSUP\n::1 ENOTSUP\n[::1] ENOTSUP\n' +
      'sni 127.0.0.1 ENOTSUP\nhost 127.0.0.1 ECONNREFUSED\nsmtp over https HTTP/1.1 400 Bad Request\n',
    stderr: '',
  });
  assert.deepEqual(transport.seen, []);
});

test('a tls connect to host.slicc.internal goes to the transport under its policy, as ctx.fetch does (#914)', async (t) => {
  const { transport, run } = await booted(t);
  assert.deepEqual(await run('hostloop'), { status: 0, stdout: 'HTTP/1.1 200 OK\n', stderr: '' });
  assert.equal(transport.seen.length, 1);
  assert.match(transport.seen[0].url, /^https:\/\/(host\.slicc\.internal|127\.0\.0\.1):8443\/h$/);
});
