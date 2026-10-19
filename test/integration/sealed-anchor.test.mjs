import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
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
  {
    exit = 'device:a1b2-c3.d4_e5',
    values = { [PH]: SECRET, [SHORT_PH]: 'short' },
    anchorsFor = () => ({ anchors: [], pins: [] }),
  } = {}
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
  const anchored = [];
  const sealed = async (req) => {
    if (req.op === 'sessionAnchors') {
      anchored.push(req);
      return anchorsFor(req);
    }
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
  return { run, asked, anchored, kernel };
}

const get = (headers, { path = '/v1/me', method = 'GET', body = '' } = {}) =>
  `${method} ${path} HTTP/1.1\r\nHost: api.test\r\n${headers.map((h) => `${h}\r\n`).join('')}${body ? `Content-Length: ${body.length}\r\n` : ''}Connection: close\r\n\r\n${body}`;

const priv = makeCa('a private CA the bundled roots lack');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const sha = (bytes) => createHash('sha256').update(bytes).digest('base64');
const spkiOfCa = (c) =>
  createHash('sha256')
    .update(
      new X509Certificate(Buffer.from(c.der)).publicKey.export({ type: 'spki', format: 'der' })
    )
    .digest('base64');
const bearer = () => get([`Authorization: Bearer ${PH}`]);

test(
  'a private CA anchored in the vault rule verifies a session the bundled roots do not, by its DER or its SPKI pin, and the request says which anchor (#1090)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, priv.server('db.test'));
    const byDer = await kernelWith(t, [['db.test', a.port]], {
      anchorsFor: () => ({ anchors: [b64(priv.der)], pins: [] }),
    });
    const [one] = await byDer.run([
      { host: 'db.test', port: 465, tls: { ca: priv.pem }, writes: [bearer()] },
    ]);
    assert.deepEqual([one.verified, one.substitutes], [false, true]);
    assert.equal(a.log[0][0].head.includes(`Bearer ${SECRET}`), true, a.log[0][0].head);
    assert.deepEqual(
      byDer.asked.map((r) => [r.verifiedBy, r.anchor]),
      [['anchored', sha(priv.der)]]
    );
    assert.deepEqual(
      byDer.anchored.map((r) => [r.op, r.host, r.port, r.protocol, r.exit, 'verified' in r]),
      [['sessionAnchors', 'db.test', 465, 'http1', 'device:a1b2-c3.d4_e5', false]]
    );
    const pin = spkiOfCa(priv);
    const byPin = await kernelWith(t, [['db.test', a.port]], {
      anchorsFor: () => ({ anchors: [], pins: [pin] }),
    });
    await byPin.run([{ host: 'db.test', port: 465, tls: { ca: priv.pem }, writes: [bearer()] }]);
    assert.equal(a.log[1][0].head.includes(`Bearer ${SECRET}`), true);
    assert.deepEqual(
      byPin.asked.map((r) => [r.verifiedBy, r.anchor]),
      [['anchored', pin]]
    );
  }
);

test(
  'the exact presented leaf can be the anchor; a bundled-verified session with no matching anchor goes as roots (#1090)',
  TIMEOUT,
  async (t) => {
    const leaf = priv.server('db.test');
    const a = await server(t, leaf);
    const exact = await kernelWith(t, [['db.test', a.port]], {
      anchorsFor: () => ({ anchors: [b64(leaf.der)], pins: [] }),
    });
    await exact.run([{ host: 'db.test', port: 465, tls: { ca: priv.pem }, writes: [bearer()] }]);
    assert.deepEqual(
      exact.asked.map((r) => [r.verifiedBy, r.anchor]),
      [['anchored', sha(leaf.der)]]
    );
    const pub = await server(t, ca.server('api.test'));
    const roots = await kernelWith(t, [['api.test', pub.port]], {
      anchorsFor: () => ({ anchors: [b64(priv.der)], pins: [] }),
    });
    await roots.run([{ host: 'api.test', port: 465, tls: {}, writes: [bearer()] }]);
    assert.deepEqual(
      roots.asked.map((r) => [r.verified, r.verifiedBy, r.anchor]),
      [[true, undefined, undefined]]
    );
  }
);

test(
  "nothing is substituted when the anchor is only the program's ca, a pin does not match, or the leaf names another host than the session (#1090)",
  TIMEOUT,
  async (t) => {
    const a = await server(t, priv.server('db.test'));
    const wrong = await server(t, priv.server('other.test'));
    const none = await kernelWith(t, [['db.test', a.port]]);
    await none.run([{ host: 'db.test', port: 465, tls: { ca: priv.pem }, writes: [bearer()] }]);
    const otherPin = await kernelWith(t, [['db.test', a.port]], {
      anchorsFor: () => ({ anchors: [], pins: [spkiOfCa(other)] }),
    });
    await otherPin.run([{ host: 'db.test', port: 465, tls: { ca: priv.pem }, writes: [bearer()] }]);
    const misnamed = await kernelWith(t, [['db.test', wrong.port]], {
      anchorsFor: () => ({ anchors: [b64(priv.der)], pins: [spkiOfCa(priv)] }),
    });
    await misnamed.run([
      {
        host: 'db.test',
        port: 465,
        tls: { ca: priv.pem, checkHostname: false },
        writes: [bearer()],
      },
    ]);
    for (const k of [none, otherPin, misnamed]) assert.deepEqual(k.asked, []);
    for (const log of [a.log, wrong.log])
      for (const conn of log) for (const r of conn) assert.equal(r.head.includes(SECRET), false);
    assert.equal(a.log.length + wrong.log.length, 3);
  }
);
