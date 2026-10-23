import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { connect as tcp } from 'node:net';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { fakeUplink } from '../../dist/testing.js';
import { makeCa } from './test-certs.mjs';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 120_000 };
const ca = makeCa();
const other = makeCa('another CA');
const PH = 'fnox_proxy_0123456789abcdef01234567';
const PH2 = 'fnox_proxy_89abcdef0123456789abcdef';
const SHORT_PH = 'fnox_proxy_aaaaaaaaaaaaaaaaaaaaaaaa';
const SECRET = 'sk-live-0123456789abcdefXYZ';
const HIDDEN = '*'.repeat(SECRET.length);
const hidden = (encoded) => `\\*{${encoded.length}}`;

const PROGRAM = `const enc = new TextEncoder();
const dec = new TextDecoder();
async function child(ctx) {
  const parent = '/proc/' + ctx.argv[2];
  while (await ctx.fs.exists(parent)) await new Promise((r) => setTimeout(r, 20));
  await ctx.write(3, ctx.argv[3]);
  let got = '';
  for (;;) {
    const chunk = await ctx.read(3);
    if (chunk.length === 0) break;
    got += dec.decode(chunk, { stream: true });
  }
  await ctx.fs.writeFile('/tmp/handoff.tmp', got);
  await ctx.fs.rename('/tmp/handoff.tmp', '/tmp/handoff.out');
}
export default async function main(ctx) {
  if (ctx.argv[1] === '__child') return child(ctx);
  const steps = JSON.parse(ctx.argv[1]);
  const out = [];
  const opened = {};
  for (const s of steps) {
    if (s.open) {
      opened[s.open] = await ctx.net.connect({ host: s.host, port: s.port, tls: s.tls });
      continue;
    }
    if (s.handoff) {
      const c = opened[s.handoff.name];
      await ctx.spawn({ argv: ['sh1', '__child', String(ctx.pid), s.handoff.writes.join('')], fds: { 3: c.fd } });
      out.push({ handedOff: true });
      continue;
    }
    if (s.spawn) {
      const child = await ctx.spawn({ argv: ['sh1', JSON.stringify(s.spawn), '/tmp/child.json'] });
      await child.wait();
      out.push({ child: JSON.parse(dec.decode(await ctx.fs.readFile('/tmp/child.json'))) });
      continue;
    }
    try {
      const c = await ctx.net.connect({ host: s.host, port: s.port, tls: s.tls });
      const w = c.writable.getWriter();
      for (const piece of s.writes) await w.write(enc.encode(piece));
      const r = c.readable.getReader();
      let got = '';
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        got += dec.decode(value, { stream: true });
      }
      out.push({ substitutes: c.tls.substitutes, verified: c.tls.verified, got });
      await c.close();
    } catch (e) {
      out.push({ code: e.code, message: e.message });
    }
  }
  if (ctx.argv[2]) await ctx.fs.writeFile(ctx.argv[2], JSON.stringify(out));
  else await ctx.write(1, JSON.stringify(out));
}
`;

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

function tokenOf(head) {
  const m = /^authorization:[ \t]*(\S+)[ \t]+(\S+)/im.exec(head);
  if (!m) return '';
  return m[1].toLowerCase() === 'basic' ? Buffer.from(m[2], 'base64').toString('latin1') : m[2];
}

function http(log, leak, delay = 0) {
  const box = { stored: '' };
  return (sock) => {
    let buf = Buffer.alloc(0);
    const conn = [];
    log.push(conn);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end + 4).toString('latin1');
        const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
        if (buf.length < end + 4 + length) return;
        const body = buf.subarray(end + 4, end + 4 + length).toString('latin1');
        buf = buf.subarray(end + 4 + length);
        conn.push({ head, body });
        const token = tokenOf(head);
        if (token) box.stored = token;
        const text = head.startsWith('GET /stored ')
          ? `STORED ${box.stored}\n`
          : leak
            ? `LEAK ${SECRET} ${Buffer.from(SECRET).toString('base64')}\n`
            : `HEAD ${head}BODY ${body}\nB64 ${Buffer.from(token).toString('base64')}\nHEX ${Buffer.from(token).toString('hex')}\n`;
        const close = /^connection:\s*close/im.test(head);
        setTimeout(() => {
          sock.write(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`
          );
          if (close) sock.end();
        }, delay);
      }
    });
  };
}

async function server(t, cert, options = {}) {
  const log = [];
  const s = createServer(
    { key: cert.key, cert: cert.cert, ...options },
    http(log, options.leak, options.delay)
  );
  s.on('tlsClientError', () => {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => s.close());
  return { port: s.address().port, log };
}

function pipeTo(port) {
  return (p) => {
    const sock = tcp(port, '127.0.0.1');
    sock.on('data', (d) => p.write(new Uint8Array(d)));
    sock.on('end', () => p.end());
    sock.on('error', () => p.end());
    void (async () => {
      for (;;) {
        const bytes = await p.read().catch(() => null);
        if (!bytes) return void sock.end();
        sock.write(bytes);
      }
    })();
  };
}

async function kernelWith(
  t,
  servers,
  { exit = 'device:a1b2-c3.d4_e5', values = { [PH]: SECRET, [SHORT_PH]: 'short' } } = {}
) {
  const names = {};
  const peers = {};
  servers.forEach(([host, port], i) => {
    const address = `203.0.113.${10 + i}`;
    names[host] = [address];
    peers[`${address}:465`] = pipeTo(port);
  });
  const uplink = fakeUplink({
    routes: { prefixes: [], exit: true },
    names,
    peers,
    ...(exit ? { exit } : {}),
  });
  const asked = [];
  const sealed = async (req) => {
    if (req.op !== 'sessionMaterialize') return { v: 1, error: { code: 'EINVAL' } };
    asked.push(req);
    const got = Object.fromEntries(
      req.placeholders.filter((p) => p in values).map((p) => [p, values[p]])
    );
    return Object.keys(got).length > 0 ? { values: got } : { v: 1, error: { code: 'EACCES' } };
  };
  const transport = {
    traits: { manualRedirects: false, encodedBodies: false, maxRequestBody: 1 << 20 },
    fetch: async () => ({
      status: 502,
      statusText: 'no',
      headers: [],
      body: (async function* () {})(),
      cancel: async () => {},
    }),
  };
  const kernel = await createNodeKernel({ users: 'off', sealed, network: { uplink, transport } });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-tls-engine');
  await kernel.writeFile('/node_modules/@ai-ecoverse/wasm-tls-engine/dist/roots.der', ca.der);
  await kernel.writeFile(
    '/node_modules/sh1/package.json',
    JSON.stringify({ name: 'sh1', slicc: { commands: { sh1: { abi: 'js', module: 'sh1.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/sh1/sh1.mjs', PROGRAM);
  const run = async (steps) => {
    const r = await kernel.run(['sh1', JSON.stringify(steps)], { cwd: '/' });
    assert.equal(r.stderr, '');
    return JSON.parse(r.stdout);
  };
  return { run, asked, kernel };
}

const get = (headers, { path = '/v1/me', method = 'GET', body = '' } = {}) =>
  `${method} ${path} HTTP/1.1\r\nHost: api.test\r\n${headers.map((h) => `${h}\r\n`).join('')}${body ? `Content-Length: ${body.length}\r\n` : ''}Connection: close\r\n\r\n${body}`;

test(
  'a placeholder in an Authorization header of the first request on a kernel-verified A2 session reaches the server as the secret, from one vault request, and the program reads it back as filler of its own length (#1090, #1509)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const { run, asked } = await kernelWith(t, [['api.test', a.port]]);
    const req = get([`Authorization: Bearer ${PH}`, 'X-Other: plain'], { path: '/v1/me?x=1' });
    const [got] = await run([
      { host: 'api.test', port: 465, tls: {}, writes: [req.slice(0, 40), req.slice(40)] },
    ]);
    assert.equal(got.substitutes, true, JSON.stringify(got));
    assert.equal(got.verified, true);
    assert.equal(
      a.log[0][0].head.includes(`Authorization: Bearer ${SECRET}\r\n`),
      true,
      a.log[0][0].head
    );
    assert.equal(got.got.includes(SECRET), false, got.got);
    assert.equal(got.got.includes(`Authorization: Bearer ${HIDDEN}\r\n`), true, got.got);
    assert.match(got.got, new RegExp(`B64 ${hidden(Buffer.from(SECRET).toString('base64'))}\n`));
    assert.match(got.got, new RegExp(`HEX ${hidden(Buffer.from(SECRET).toString('hex'))}\n`));
    assert.equal(asked.length, 1);
    const { stamp, caller, session, handshakeAt, ...rest } = asked[0];
    assert.deepEqual(rest, {
      v: 1,
      op: 'sessionMaterialize',
      host: 'api.test',
      port: 465,
      protocol: 'http1',
      position: 'header:authorization',
      verified: true,
      verifiedBy: 'roots',
      exit: 'device:a1b2-c3.d4_e5',
      placeholders: [PH],
      head: { method: 'GET', path: '/v1/me?x=1' },
    });
    assert.match(session, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(typeof handshakeAt, 'number');
    assert.equal((stamp.pid > 0 && caller === stamp) || caller.pid === stamp.pid, true);
  }
);

test(
  'Basic credentials are decoded, substituted and re-encoded, at the user:password position (#1090)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const { run } = await kernelWith(t, [['api.test', a.port]]);
    const basic = Buffer.from(`alice:${PH}`).toString('base64');
    const [got] = await run([
      { host: 'api.test', port: 465, tls: {}, writes: [get([`Authorization: Basic ${basic}`])] },
    ]);
    assert.equal(tokenOf(a.log[0][0].head), `alice:${SECRET}`);
    assert.equal(got.got.includes(SECRET), false);
  }
);

test(
  'placeholders go out as written, and the vault is not asked, for an unverified session, a session with no exit, h2, a body or request-line placeholder, two credential headers or a later request; a refusal or a short value leaves them too (#1090)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const h2 = await server(t, ca.server('h2.test'), { ALPNProtocols: ['h2'] });
    const { run, asked } = await kernelWith(t, [
      ['api.test', a.port],
      ['h2.test', h2.port],
    ]);
    const auth = `Authorization: Bearer ${PH}`;
    const steps = [
      { host: 'api.test', port: 465, tls: { ca: ca.pem }, writes: [get([auth])] },
      { host: 'h2.test', port: 465, tls: { alpn: ['h2'] }, writes: [get([auth])] },
      {
        host: 'api.test',
        port: 465,
        tls: {},
        writes: [get(['X-A: 1'], { method: 'POST', body: `token=${PH}` })],
      },
      { host: 'api.test', port: 465, tls: {}, writes: [get([], { path: `/x?k=${PH}` })] },
      { host: 'api.test', port: 465, tls: {}, writes: [get([auth, `X-Api-Key: ${PH}`])] },
      { host: 'api.test', port: 465, tls: {}, writes: [get([`Authorization: Bearer ${PH2}`])] },
      {
        host: 'api.test',
        port: 465,
        tls: {},
        writes: [get([`Authorization: Bearer ${SHORT_PH}`])],
      },
      {
        host: 'api.test',
        port: 465,
        tls: {},
        writes: [get(['X-A: 1']).replace('Connection: close\r\n', '') + get([auth])],
      },
    ];
    const got = await run(steps);
    assert.deepEqual(
      got.map((g) => [g.verified, g.substitutes]),
      [
        [false, true],
        [true, false],
        [true, true],
        [true, true],
        [true, true],
        [true, true],
        [true, true],
        [true, true],
      ]
    );
    const heads = a.log.map((conn) => conn.map((r) => r.head + r.body).join('|'));
    for (const h of heads) assert.equal(h.includes(SECRET), false, h);
    assert.equal(heads.length, 7);
    for (const [i, ph] of [
      [0, PH],
      [1, PH],
      [2, PH],
      [3, PH],
      [4, PH2],
      [5, SHORT_PH],
      [6, PH],
    ])
      assert.equal(heads[i].includes(ph), true, heads[i]);
    assert.equal(h2.log[0].length, 1);
    assert.equal(h2.log[0][0].head.includes(PH), true);
    assert.deepEqual(
      asked.map((r) => [r.position, r.placeholders]),
      [
        ['header:authorization', [PH2]],
        ['header:authorization', [SHORT_PH]],
      ]
    );
    const { run: noExit, asked: none } = await kernelWith(t, [['api.test', a.port]], { exit: '' });
    const [plain] = await noExit([{ host: 'api.test', port: 465, tls: {}, writes: [get([auth])] }]);
    assert.deepEqual([plain.verified, plain.substitutes], [true, false]);
    assert.equal(a.log.at(-1)[0].head.includes(PH), true);
    assert.deepEqual(none, []);
  }
);

test(
  'once a process has substituted a value for a host, every later A2 session of that process to that host reads it back scrubbed, verified or not (#1090)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const leak = await server(t, other.server('api.test'), { leak: true });
    const { run } = await kernelWith(t, [
      ['api.test', a.port],
      ['leak.test', leak.port],
    ]);
    const steps = [
      {
        host: 'leak.test',
        port: 465,
        tls: { ca: other.pem, servername: 'api.test' },
        writes: [get([])],
      },
      { host: 'api.test', port: 465, tls: {}, writes: [get([`Authorization: Bearer ${PH}`])] },
      {
        host: 'leak.test',
        port: 465,
        tls: { ca: other.pem, servername: 'api.test' },
        writes: [get([])],
      },
    ];
    const [before, , after] = await run(steps);
    assert.equal(before.got.includes(`LEAK ${SECRET}`), true, before.got);
    assert.equal(after.got.includes(SECRET), false, after.got);
    assert.match(
      after.got,
      new RegExp(`LEAK ${hidden(SECRET)} ${hidden(Buffer.from(SECRET).toString('base64'))}\n`)
    );
  }
);

test(
  'the scrub covers the process tree: a child spawned after its parent had a value substituted reads a stored copy back from its own session scrubbed (#1090, #1509)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const { run } = await kernelWith(t, [['api.test', a.port]]);
    const steps = [
      { host: 'api.test', port: 465, tls: {}, writes: [get([`Authorization: Bearer ${PH}`])] },
      {
        spawn: [
          {
            host: 'api.test',
            port: 465,
            tls: { ca: ca.pem },
            writes: [get([], { path: '/stored' })],
          },
        ],
      },
    ];
    const [first, { child }] = await run(steps);
    assert.equal(first.substitutes, true);
    assert.equal(tokenOf(a.log[0][0].head), SECRET);
    assert.equal(child[0].got.includes(SECRET), false, child[0].got);
    assert.match(child[0].got, new RegExp(`STORED ${hidden(SECRET)}\n`));
    const [alone] = await run([
      { host: 'api.test', port: 465, tls: { ca: ca.pem }, writes: [get([], { path: '/stored' })] },
    ]);
    assert.match(alone.got, new RegExp(`STORED ${SECRET}`));
  }
);

test(
  'a session opened before the substitution and handed to a child stays scrubbed after the parent that substituted has exited (#1090 review)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const leak = await server(t, other.server('api.test'), { leak: true, delay: 1500 });
    const { run, kernel } = await kernelWith(t, [
      ['api.test', a.port],
      ['leak.test', leak.port],
    ]);
    await run([
      {
        open: 'leak',
        host: 'leak.test',
        port: 465,
        tls: { ca: other.pem, servername: 'api.test' },
      },
      { host: 'api.test', port: 465, tls: {}, writes: [get([`Authorization: Bearer ${PH}`])] },
      { handoff: { name: 'leak', writes: [get([])] } },
    ]);
    let got;
    for (let i = 0; i < 500 && got === undefined; i++) {
      got = await kernel.readFile('/tmp/handoff.out').then(
        (b) => new TextDecoder().decode(b),
        () => undefined
      );
      if (got === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    assert.notEqual(got, undefined);
    assert.equal(got.includes(SECRET), false, got);
    assert.match(got, new RegExp(`LEAK ${hidden(SECRET)} `));
  }
);

test(
  'a session that is neither http1, SMTP nor pg passes the server short replies through at once, never held for the pg parser (#1138 review)',
  TIMEOUT,
  async (t) => {
    const leaf = ca.server('api.test');
    const s = createServer({ key: leaf.key, cert: leaf.cert }, (sock) => {
      sock.on('error', () => {});
      sock.once('data', () => sock.end('ok'));
    });
    s.on('tlsClientError', () => {});
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    t.after(() => s.close());
    const { run } = await kernelWith(t, [['api.test', s.address().port]]);
    const [got] = await run([{ host: 'api.test', port: 465, tls: {}, writes: ['hello\n'] }]);
    assert.deepEqual([got.substitutes, got.got], [true, 'ok']);
  }
);

function framed(text) {
  const out = [];
  let rest = Buffer.from(text);
  while (rest.length > 0) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) return { out, trailing: rest.toString() };
    const head = rest.subarray(0, end).toString();
    const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
    out.push({
      status: head.split('\r\n')[0],
      body: rest.subarray(end + 4, end + 4 + length).toString(),
    });
    rest = rest.subarray(end + 4 + length);
  }
  return { out, trailing: '' };
}

test(
  'a secret the server reflects in a Content-Length body is scrubbed to its own length, so the next response on the connection still parses (#1509)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const { run } = await kernelWith(t, [['api.test', a.port]]);
    const first = `GET /v1/me HTTP/1.1\r\nHost: api.test\r\nAuthorization: Bearer ${PH}\r\n\r\n`;
    const [got] = await run([
      { host: 'api.test', port: 465, tls: {}, writes: [first, get([], { path: '/stored' })] },
    ]);
    assert.equal(got.substitutes, true, JSON.stringify(got));
    assert.equal(got.got.includes(SECRET), false);
    const { out, trailing } = framed(got.got);
    assert.deepEqual(
      out.map((r) => r.status),
      ['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK'],
      JSON.stringify(got.got)
    );
    assert.equal(trailing, '');
    assert.match(out[0].body, new RegExp(`Authorization: Bearer \\*{${SECRET.length}}\\r\\n`));
    assert.equal(out[1].body, `STORED ${HIDDEN}\n`);
  }
);

test(
  'a keylogged A2 session is never sealed: the placeholder reaches the server as written and the session says substitutes: false; a keylog on the transport path is ENOTSUP (#1504)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const { run, asked } = await kernelWith(t, [['api.test', a.port]]);
    const req = get([`Authorization: Bearer ${PH}`]);
    const [got] = await run([
      { host: 'api.test', port: 465, tls: { keylog: true }, writes: [req] },
    ]);
    assert.equal(got.substitutes, false, JSON.stringify(got));
    assert.equal(
      a.log[0][0].head.includes(`Authorization: Bearer ${PH}\r\n`),
      true,
      a.log[0][0].head
    );
    assert.equal(asked.length, 0);
    const [transport] = await run([
      { host: 'elsewhere.test', port: 443, tls: { keylog: true }, writes: [req] },
    ]);
    assert.equal(transport.code, 'ENOTSUP', JSON.stringify(transport));
  }
);
