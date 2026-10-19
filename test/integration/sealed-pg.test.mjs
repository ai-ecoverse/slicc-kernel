import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer as createTcp, connect as tcp } from 'node:net';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { TLSSocket } from 'node:tls';
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
function int32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function latin(b) { let s = ''; for (const x of b) s += String.fromCharCode(x); return s; }
export default async function main(ctx) {
  const steps = JSON.parse(ctx.argv[1]);
  const out = [];
  for (const s of steps) {
    try {
      const plain = await ctx.net.connect({ host: s.host, port: 5432 });
      const pw = plain.writable.getWriter();
      await pw.write(new Uint8Array([...int32(8), ...int32(80877103)]));
      const pr = plain.readable.getReader();
      const yes = await pr.read();
      pw.releaseLock();
      pr.releaseLock();
      if (latin(yes.value) !== 'S') throw new Error('no S');
      const c = await ctx.net.connect({ socket: plain, host: s.host, tls: s.tls ?? {} });
      const w = c.writable.getWriter();
      const r = c.readable.getReader();
      const params = enc.encode('user\\0alice\\0database\\0x\\0\\0');
      await w.write(new Uint8Array([...int32(8 + params.length), ...int32(196608), ...params]));
      let got = '';
      while (got.length < 9 || got.length < 1 + ((got.charCodeAt(1) << 24) | (got.charCodeAt(2) << 16) | (got.charCodeAt(3) << 8) | got.charCodeAt(4))) {
        const { value, done } = await r.read();
        if (done) break;
        got += latin(value);
      }
      const body = enc.encode(s.password + '\\0');
      await w.write(new Uint8Array([0x70, ...int32(4 + body.length), ...body]));
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        got += latin(value);
      }
      out.push({ substitutes: c.tls.substitutes, verified: c.tls.verified, got });
      await c.close();
    } catch (e) {
      out.push({ code: e.code, message: e.message });
    }
  }
  await ctx.write(1, JSON.stringify(out));
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

const int32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const message = (type, body) => Buffer.concat([Buffer.from(type), int32(4 + body.length), body]);
const AUTH = {
  cleartext: () => message('R', int32(3)),
  md5: () => message('R', Buffer.concat([int32(5), Buffer.from([1, 2, 3, 4])])),
  scram: () => message('R', Buffer.concat([int32(10), Buffer.from('SCRAM-SHA-256\0\0')])),
  negative: () =>
    Buffer.concat([
      Buffer.from('N'),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      message('R', int32(3)),
    ]),
};

async function pgServer(t, cert, method) {
  const log = [];
  const srv = createTcp((sock) => {
    sock.on('error', () => {});
    sock.once('data', () => {
      sock.write('S');
      const s = new TLSSocket(sock, { isServer: true, key: cert.key, cert: cert.cert });
      s.on('error', () => {});
      let buf = Buffer.alloc(0);
      let started = false;
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!started && buf.length >= 4 && buf.length >= buf.readInt32BE(0)) {
          buf = buf.subarray(buf.readInt32BE(0));
          started = true;
          s.write(AUTH[method]());
        }
        if (started && buf.length >= 5 && buf.length >= 1 + buf.readInt32BE(1)) {
          const body = buf.subarray(5, 1 + buf.readInt32BE(1)).toString('latin1');
          const password = body.replace(/\0$/, '');
          log.push({ type: String.fromCharCode(buf[0]), password });
          const fields = Buffer.from(
            `SFATAL\0C28P01\0Mpassword authentication failed: got "${password}" b64 ${Buffer.from(password).toString('base64')}\0\0`,
            'latin1'
          );
          s.end(message('E', fields));
        }
      });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { port: srv.address().port, log };
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
    peers[`${address}:5432`] = pipeTo(port);
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
    '/node_modules/pg1/package.json',
    JSON.stringify({ name: 'pg1', slicc: { commands: { pg1: { abi: 'js', module: 'pg1.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/pg1/pg1.mjs', PROGRAM);
  const run = async (steps) => {
    const r = await kernel.run(['pg1', JSON.stringify(steps)], { cwd: '/' });
    assert.equal(r.stderr, '');
    return JSON.parse(r.stdout);
  };
  return { run, asked };
}

test(
  'pg: the PasswordMessage answering AuthenticationCleartextPassword (R 3) is substituted, and an ErrorResponse quoting it reads back scrubbed; MD5 and SCRAM answers go out as written, with no request (#1090)',
  TIMEOUT,
  async (t) => {
    const clear = await pgServer(t, ca.server('db.test'), 'cleartext');
    const md5 = await pgServer(t, ca.server('md5.test'), 'md5');
    const scram = await pgServer(t, ca.server('scram.test'), 'scram');
    const { run, asked } = await kernelWith(t, [
      ['db.test', clear.port],
      ['md5.test', md5.port],
      ['scram.test', scram.port],
    ]);
    const got = await run([
      { host: 'db.test', password: PH },
      { host: 'md5.test', password: PH },
      { host: 'scram.test', password: PH },
      { host: 'db.test', password: `x${SHORT_PH}` },
    ]);
    assert.equal(clear.log[0].password, SECRET);
    assert.deepEqual([got[0].verified, got[0].substitutes], [true, true]);
    assert.equal(got[0].got.includes(SECRET), false, got[0].got);
    assert.equal(got[0].got.includes(Buffer.from(SECRET).toString('base64')), false);
    assert.match(got[0].got, new RegExp(`got "${PH}" b64 \\[redacted:sealed\\]`));
    assert.equal(md5.log[0].password, PH);
    assert.equal(scram.log[0].password, PH);
    assert.equal(clear.log[1].password, `x${SHORT_PH}`);
    assert.deepEqual(
      asked.map((r) => [r.protocol, r.position, r.placeholders, r.port]),
      [
        ['pg', 'password-cleartext', [PH], 5432],
        ['pg', 'password-cleartext', [SHORT_PH], 5432],
      ]
    );
  }
);

test(
  'pg: a server frame with a negative length stops the kernel following the server, without spinning; the session goes on and nothing is substituted (#1090, #1136 review)',
  TIMEOUT,
  async (t) => {
    const bad = await pgServer(t, ca.server('db.test'), 'negative');
    const { run, asked } = await kernelWith(t, [['db.test', bad.port]]);
    const started = Date.now();
    const [got] = await run([{ host: 'db.test', password: PH }]);
    assert.ok(Date.now() - started < 30_000, 'the kernel answered');
    assert.equal(got.verified, true, JSON.stringify(got));
    assert.equal(bad.log[0].password, PH);
    assert.deepEqual(asked, []);
  }
);
