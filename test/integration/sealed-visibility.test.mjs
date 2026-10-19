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

const HOLDER = `const enc = new TextEncoder();
const dec = new TextDecoder();
export default async function main(ctx) {
  const c = await ctx.net.connect({ host: 'api.test', port: 465, tls: {} });
  const w = c.writable.getWriter();
  await w.write(enc.encode('GET /v1/me HTTP/1.1\\r\\nHost: api.test\\r\\nAuthorization: Bearer ${PH}\\r\\n\\r\\n'));
  const r = c.readable.getReader();
  const { value } = await r.read();
  await ctx.fs.writeFile('/tmp/held', dec.decode(value));
  while (!(await ctx.fs.exists('/tmp/go'))) await new Promise((x) => setTimeout(x, 20));
  await ctx.write(1, 'done ' + c.tls.substitutes + '\\n');
  await c.close();
}
`;

const WALKER = `const dec = new TextDecoder();
export default async function main(ctx) {
  const out = [];
  const walk = async (dir, depth) => {
    for (const name of await ctx.fs.readdir(dir).catch(() => [])) {
      const path = dir + '/' + name;
      const body = await ctx.fs.readFile(path).catch(() => undefined);
      if (body !== undefined) out.push(path + '=' + dec.decode(body));
      else if (depth > 0) await walk(path, depth - 1);
    }
  };
  await walk('/proc', 3);
  await ctx.write(1, JSON.stringify({ files: out.length, text: out.join('\\n') }));
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

test(
  'a value substituted into an A2 session never shows to any uid: not in /proc as another user or root, during the session or after, and not in the kernel host output (#1090, §3.19)',
  TIMEOUT,
  async (t) => {
    const a = await server(t, ca.server('api.test'));
    const uplink = fakeUplink({
      routes: { prefixes: [], exit: true },
      names: { 'api.test': ['203.0.113.10'] },
      peers: { '203.0.113.10:465': pipeTo(a.port) },
      exit: 'tailscale',
    });
    const sealed = async (req) =>
      req.op === 'sessionMaterialize'
        ? { values: { [PH]: SECRET } }
        : { v: 1, error: { code: 'EINVAL' } };
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
    const host = [];
    const writes = [process.stdout.write, process.stderr.write];
    const capture = (orig) =>
      function (chunk, ...rest) {
        host.push(String(chunk));
        return orig.call(this, chunk, ...rest);
      };
    process.stdout.write = capture(writes[0]);
    process.stderr.write = capture(writes[1]);
    const logs = [];
    t.after(() => {
      [process.stdout.write, process.stderr.write] = writes;
    });
    const kernel = await createNodeKernel({
      users: 'enforce',
      sealed,
      network: { uplink, transport },
      onDenial: (d) => logs.push(JSON.stringify(d)),
    });
    t.after(() => kernel.terminate());
    for (const name of ['alice', 'mallory']) await kernel.users.add({ name });
    await install(kernel, 'wasm-tls-engine');
    await kernel.writeFile('/node_modules/@ai-ecoverse/wasm-tls-engine/dist/roots.der', ca.der);
    for (const [name, body] of [
      ['holder', HOLDER],
      ['walker', WALKER],
    ]) {
      await kernel.writeFile(
        `/node_modules/${name}/package.json`,
        JSON.stringify({
          name,
          slicc: { commands: { [name]: { abi: 'js', module: `${name}.mjs` } } },
        })
      );
      await kernel.writeFile(`/node_modules/${name}/${name}.mjs`, body);
    }
    await kernel.run(['sh', '-c', 'true'], { cwd: '/' }).catch(() => undefined);
    const holding = kernel.run(['holder'], { cwd: '/tmp', user: 'alice' });
    let held;
    for (let i = 0; i < 1000 && held === undefined; i++) {
      held = await kernel.readFile('/tmp/held').then(
        (b) => new TextDecoder().decode(b),
        () => undefined
      );
      if (held === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    assert.notEqual(held, undefined);
    assert.equal(a.log[0][0].head.includes(`Bearer ${SECRET}`), true, a.log[0][0].head);
    const during = {};
    for (const user of ['mallory', 'root', 'alice'])
      during[user] = await kernel.run(['walker'], { cwd: '/', user });
    await kernel.writeFile('/tmp/go', '1');
    const done = await holding;
    assert.equal(done.stdout, 'done true\n', done.stderr);
    const after = await kernel.run(['walker'], { cwd: '/', user: 'mallory' });
    for (const [label, r] of [...Object.entries(during), ['after', after]]) {
      const walked = JSON.parse(r.stdout);
      assert.ok(walked.files > 10, `${label} walked ${walked.files} files`);
      assert.equal(walked.text.includes(SECRET), false, `${label} sees the value in /proc`);
      assert.equal(r.stderr.includes(SECRET), false);
    }
    assert.match(JSON.parse(during.root.stdout).text, /holder/, "root reads the holder's /proc");
    assert.match(JSON.parse(during.alice.stdout).text, /holder/, 'alice reads her own /proc');
    assert.equal(held.includes(SECRET), false, held);
    assert.equal(host.join('').includes(SECRET), false, 'host output');
    assert.equal(logs.join('').includes(SECRET), false, 'denial log');
  }
);
