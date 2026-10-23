import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer as createTcp, connect as tcp } from 'node:net';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { createServer, TLSSocket } from 'node:tls';
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
function replies(c) {
  const r = c.readable.getReader();
  let buf = '';
  return {
    async next() {
      for (;;) {
        const lines = buf.split('\\r\\n');
        for (let i = 0; i < lines.length - 1; i++) {
          if (/^\\d{3} /.test(lines[i])) {
            const reply = lines.slice(0, i + 1).join('\\n');
            buf = lines.slice(i + 1).join('\\r\\n');
            return reply;
          }
        }
        const { value, done } = await r.read();
        if (done) return 'EOF';
        buf += dec.decode(value, { stream: true });
      }
    },
    release: () => r.releaseLock(),
  };
}
export default async function main(ctx) {
  const steps = JSON.parse(ctx.argv[1]);
  const out = [];
  for (const s of steps) {
    try {
      let c = await ctx.net.connect({ host: s.host, port: s.port, ...(s.tls ? { tls: s.tls } : {}) });
      let w = c.writable.getWriter();
      let rd = replies(c);
      const got = [await rd.next()];
      let tls;
      for (const line of s.lines) {
        await w.write(enc.encode(line + '\\r\\n'));
        got.push(await rd.next());
        if (line === 'STARTTLS') {
          w.releaseLock();
          rd.release();
          c = await ctx.net.connect({ socket: c, host: s.host, tls: s.starttls });
          w = c.writable.getWriter();
          rd = replies(c);
        }
      }
      tls = c.tls;
      out.push({ substitutes: tls?.substitutes, verified: tls?.verified, got });
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

function smtp(log, conn) {
  return (sock, plainSock) => {
    let buf = '';
    let want;
    const say = (t) => sock.write(`${t}\r\n`);
    const auth = (mech, arg) => {
      const decoded = Buffer.from(arg, 'base64').toString('latin1');
      conn.push({ mech, arg, decoded });
      const pass = mech === 'plain' ? (decoded.split('\0')[2] ?? '') : decoded;
      say(`535 5.7.8 rejected ${arg} pass=${pass}`);
    };
    const onLine = (line) => {
      conn.push({ line });
      if (want) {
        const w = want;
        want = undefined;
        return w(line);
      }
      const m = /^AUTH (PLAIN|LOGIN)(?: (\S+))?$/i.exec(line);
      if (m && m[1].toUpperCase() === 'PLAIN') {
        if (m[2]) return auth('plain', m[2]);
        want = (l) => auth('plain', l);
        return say('334 ');
      }
      if (m) {
        const pass = () => {
          want = (l) => auth('login', l);
          say('334 UGFzc3dvcmQ6');
        };
        if (m[2]) return pass();
        want = () => pass();
        return say('334 VXNlcm5hbWU6');
      }
      if (/^EHLO/i.test(line)) return say(`250-mail.test\r\n250-AUTH PLAIN LOGIN\r\n250 STARTTLS`);
      if (line === 'STARTTLS' && plainSock) {
        say('220 go');
        sock.removeAllListeners('data');
        const secure = new TLSSocket(sock, {
          isServer: true,
          key: plainSock.key,
          cert: plainSock.cert,
        });
        secure.on('error', () => {});
        smtp(log, conn)(secure);
        return;
      }
      if (line === 'QUIT') {
        say('221 bye');
        return sock.end();
      }
      return say('250 ok');
    };
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
  };
}

async function servers(t, cert) {
  const log = [];
  const tls = createServer({ key: cert.key, cert: cert.cert }, (s) => {
    const conn = [];
    log.push(conn);
    s.write('220 mail.test ESMTP\r\n');
    smtp(log, conn)(s);
  });
  tls.on('tlsClientError', () => {});
  const plain = createTcp((s) => {
    const conn = [];
    log.push(conn);
    s.write('220 mail.test ESMTP\r\n');
    smtp(log, conn)(s, cert);
  });
  for (const srv of [tls, plain]) {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => srv.close());
  }
  return { ports: [tls.address().port, plain.address().port], log };
}

const plainArg = (user, pass) => Buffer.from(`\0${user}\0${pass}`).toString('base64');
const b64 = (t) => Buffer.from(t).toString('base64');

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
    const [tls, plain] = Array.isArray(port) ? port : [port, port];
    peers[`${address}:465`] = pipeTo(tls);
    peers[`${address}:2525`] = pipeTo(plain);
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
    '/node_modules/sm1/package.json',
    JSON.stringify({ name: 'sm1', slicc: { commands: { sm1: { abi: 'js', module: 'sm1.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/sm1/sm1.mjs', PROGRAM);
  const run = async (steps) => {
    const r = await kernel.run(['sm1', JSON.stringify(steps)], { cwd: '/' });
    assert.equal(r.stderr, '');
    return JSON.parse(r.stdout);
  };
  return { run, asked };
}

test(
  'SMTP AUTH PLAIN on implicit TLS: the password field is substituted, at three base64 alignments, and the echoed blob and password read back scrubbed (#1090)',
  TIMEOUT,
  async (t) => {
    const m = await servers(t, ca.server('mail.test'));
    const { run, asked } = await kernelWith(t, [['mail.test', m.ports]]);
    const users = ['a', 'ab', 'abc'];
    const got = await run(
      users.map((u) => ({
        host: 'mail.test',
        port: 465,
        tls: {},
        lines: ['EHLO me', `AUTH PLAIN ${plainArg(u, PH)}`, 'QUIT'],
      }))
    );
    users.forEach((u, i) => {
      const auth = m.log[i].find((e) => e.mech);
      assert.equal(auth.decoded, `\0${u}\0${SECRET}`);
      const text = JSON.stringify(got[i]);
      assert.equal(got[i].substitutes, true);
      assert.equal(text.includes(SECRET), false, text);
      assert.equal(text.includes(auth.arg), false, text);
      assert.match(got[i].got[2], new RegExp(`pass=\\*{${SECRET.length}}$`));
    });
    assert.deepEqual(
      asked.map((r) => [r.protocol, r.position, r.placeholders, 'head' in r]),
      users.map(() => ['smtp', 'auth-plain', [PH], false])
    );
  }
);

test(
  'SMTP AUTH PLAIN after a 334, and AUTH LOGIN, substitute the password only; a placeholder as the user, in MAIL FROM, or in an AUTH after MAIL goes out as written (#1090)',
  TIMEOUT,
  async (t) => {
    const m = await servers(t, ca.server('mail.test'));
    const { run, asked } = await kernelWith(t, [['mail.test', m.ports]]);
    const s = (lines) => ({
      host: 'mail.test',
      port: 465,
      tls: {},
      lines: ['EHLO me', ...lines, 'QUIT'],
    });
    const got = await run([
      s(['AUTH PLAIN', plainArg('alice', PH)]),
      s(['AUTH LOGIN', b64('alice'), b64(PH)]),
      s([`AUTH LOGIN ${b64('alice')}`, b64(PH)]),
      s([`AUTH PLAIN ${plainArg(PH, 'x')}`]),
      s(['AUTH LOGIN', b64(PH), b64('plainpass')]),
      s([`MAIL FROM:<${PH}@x>`, `AUTH PLAIN ${plainArg('alice', PH)}`]),
    ]);
    const authOf = (i) => m.log[i].find((e) => e.mech);
    assert.equal(authOf(0).decoded, `\0alice\0${SECRET}`);
    assert.equal(authOf(1).decoded, SECRET);
    assert.equal(authOf(2).decoded, SECRET);
    assert.equal(authOf(3).decoded, `\0${PH}\0x`);
    assert.equal(authOf(4).decoded, 'plainpass');
    assert.equal(authOf(5).decoded, `\0alice\0${PH}`);
    assert.equal(
      m.log[5].some((e) => e.line === `MAIL FROM:<${PH}@x>`),
      true
    );
    for (const g of got) assert.equal(JSON.stringify(g).includes(SECRET), false);
    assert.deepEqual(
      asked.map((r) => r.position),
      ['auth-plain', 'auth-login', 'auth-login']
    );
  }
);

test(
  'STARTTLS: an AUTH before the upgrade goes out as written; after it, on the verified session, it is substituted (#1090)',
  TIMEOUT,
  async (t) => {
    const m = await servers(t, ca.server('mail.test'));
    const { run, asked } = await kernelWith(t, [['mail.test', m.ports]]);
    const [got] = await run([
      {
        host: 'mail.test',
        port: 2525,
        starttls: {},
        lines: [
          'EHLO me',
          `AUTH PLAIN ${plainArg('alice', PH)}`,
          'STARTTLS',
          'EHLO me',
          `AUTH PLAIN ${plainArg('alice', PH)}`,
          'QUIT',
        ],
      },
    ]);
    const auths = m.log[0].filter((e) => e.mech);
    assert.equal(auths.length, 2);
    assert.equal(auths[0].decoded, `\0alice\0${PH}`);
    assert.equal(auths[1].decoded, `\0alice\0${SECRET}`);
    assert.deepEqual([got.verified, got.substitutes], [true, true]);
    assert.equal(JSON.stringify(got).includes(SECRET), false);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].port, 2525);
  }
);
