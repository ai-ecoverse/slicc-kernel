import assert from 'node:assert/strict';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { makeCa, selfSigned } from './test-certs.mjs';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 90_000 };

const PACKAGE = JSON.stringify({
  name: 'tlsd',
  slicc: {
    commands: {
      tlsd: { abi: 'js', module: 'bin/tlsd.mjs' },
      tlsc: { abi: 'js', module: 'bin/tlsc.mjs' },
      tlsone: { abi: 'js', module: 'bin/tlsone.mjs' },
      tlsparity: { abi: 'js', module: 'bin/tlsparity.mjs' },
      tlsselect: { abi: 'js', module: 'bin/tlsselect.mjs' },
    },
  },
});

const SHARED = `const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (v) => btoa(String.fromCharCode(...v));
const shown = (tls) => tls && JSON.parse(JSON.stringify(tls, (k, v) => (v instanceof Uint8Array ? b64(v) : v)));
const failure = (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? '', alert: err.alert });
async function drain(readable) {
  let text = '';
  for await (const chunk of readable) text += dec.decode(chunk);
  return text;
}
`;

const SERVER = `${SHARED}
async function answer(c) {
  const reader = c.readable.getReader();
  let head = '';
  while (!head.includes('\\r\\n\\r\\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    head += dec.decode(value);
  }
  const w = c.writable.getWriter();
  await w.write(enc.encode('HTTP/1.1 200 OK\\r\\ncontent-length: 5\\r\\nconnection: close\\r\\n\\r\\nhello'));
  await w.close();
  return head.split('\\r\\n')[0];
}
export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  const say = (v) => ctx.write(1, JSON.stringify({ server: v }) + '\\n');
  let l;
  try {
    if (o.mode === 'secure') l = await ctx.net.listen({});
    else if (o.mode === 'sync') l = ctx.sync.net.listen({ tls: o.tls });
    else l = await ctx.net.listen({ tls: o.tls });
  } catch (err) {
    say({ listen: failure(err) });
    return 0;
  }
  const served = [];
  const serving = (async () => {
    for (;;) {
      let c;
      try {
        c = await l.accept();
      } catch {
        return;
      }
      served.push(
        (async () => {
          try {
            if (o.mode === 'secure') c = await ctx.net.secure(c, { server: true, ...o.tls });
            const line = await answer(c);
            say({ tls: shown(c.tls), line });
          } catch (err) {
            say({ accept: failure(err) });
            await c.close();
          }
        })()
      );
    }
  })();
  for (const client of o.clients) {
    const child = await ctx.spawn({ argv: ['tlsc', JSON.stringify({ ...client, port: l.port })] });
    await child.wait();
  }
  await Promise.all(served);
  await l.close();
  await serving;
  return 0;
}
`;

const CLIENT = `${SHARED}
export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  const say = (v) => ctx.write(1, JSON.stringify({ client: o.name, ...v }) + '\\n');
  try {
    const c = await ctx.net.connect({ host: o.host ?? 'localhost', port: o.port, tls: o.tls });
    const w = c.writable.getWriter();
    await w.write(enc.encode('GET /x HTTP/1.1\\r\\nhost: localhost\\r\\n\\r\\n'));
    const text = await drain(c.readable);
    say({ tls: shown(c.tls), status: text.split('\\r\\n')[0], body: text.split('\\r\\n\\r\\n')[1] });
    await c.close();
  } catch (err) {
    say({ error: failure(err) });
  }
  return 0;
}
`;

const ONE = `${SHARED}
const within = (p, ms) =>
  Promise.race([p.then((v) => ({ v }), (e) => ({ e: failure(e) })), new Promise((r) => setTimeout(() => r({ hung: true }), ms))]);
async function roundTrip(c, text) {
  const w = c.writable.getWriter();
  await w.write(enc.encode(text));
  await w.close();
  return drain(c.readable);
}
async function echo(c) {
  const r = c.readable.getReader();
  const { value } = await r.read();
  r.releaseLock();
  const w = c.writable.getWriter();
  await w.write(value);
  await w.close();
}
export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  const out = {};
  const alive = async () => {
    await ctx.fs.writeFile('/tmp/alive', 'yes');
    return dec.decode(await ctx.fs.readFile('/tmp/alive'));
  };
  const l = await ctx.net.listen({ tls: { cert: o.cert, key: o.key } });
  const a = l.accept();
  const c = ctx.net.connect({ host: 'localhost', port: l.port, tls: { ca: o.cert } });
  const both = await within(Promise.all([a, c]), 10000);
  out.same = both.hung ? 'hung' : both.e ? both.e.code : 'ok';
  if (!both.hung && !both.e) {
    const [served, client] = both.v;
    const echoed = echo(served);
    out.sameEcho = await roundTrip(client, 'same');
    await echoed;
  }
  const idle = await ctx.net.connect({ port: l.port });
  const next = l.accept();
  const real = await within(ctx.net.connect({ host: 'localhost', port: l.port, tls: { ca: o.cert } }), 10000);
  out.afterIdle = real.hung ? 'hung' : real.e ? real.e.code : 'ok';
  out.aliveAfterIdle = (await within(alive(), 5000)).v ?? 'hung';
  const got = await within(next, 10000);
  if (!got.hung && !got.e) {
    const echoed = echo(got.v);
    out.idleEcho = await roundTrip(real.v, 'next');
    await echoed;
  }
  const stop = new AbortController();
  const waiting = l.accept({ signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  const aborted = await within(waiting, 5000);
  out.aborted = aborted.hung ? 'hung' : aborted.e ? aborted.e.message : 'accepted';
  out.aliveAfterAbort = (await within(alive(), 5000)).v ?? 'hung';
  await idle.close();
  await l.close();
  const plain = await ctx.net.listen({});
  const quiet = plain.accept();
  const raw = await ctx.net.connect({ port: plain.port });
  const served = await quiet;
  const timed = await within(ctx.net.secure(served, { server: true, cert: o.cert, key: o.key, handshakeTimeout: 200 }), 5000);
  out.timeout = timed.hung ? 'hung' : timed.e ? timed.e.code : 'served';
  await raw.close();
  const silent = plain.accept();
  const cancel = new AbortController();
  const dialling = ctx.net.connect({ host: 'localhost', port: plain.port, tls: { ca: o.cert }, signal: cancel.signal });
  const held = await silent;
  setTimeout(() => cancel.abort(), 100);
  const dialled = await within(dialling, 5000);
  out.clientAbort = dialled.hung ? 'hung' : dialled.e ? 'refused' : 'connected';
  out.aliveAfterClient = (await within(alive(), 5000)).v ?? 'hung';
  await held.close();
  await plain.close();
  ctx.write(1, JSON.stringify(out) + '\\n');
  return 0;
}
`;

const PARITY = `${SHARED}
export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  const out = {};
  const plain = await ctx.net.listen({});
  const tls = { server: true, cert: o.cert, key: o.key };
  const a1 = plain.accept();
  const http = await ctx.net.connect({ port: plain.port });
  const s1 = await a1;
  const hw = http.writable.getWriter();
  await hw.write(enc.encode('GET / HTTP/1.1\\r\\nhost: x\\r\\n\\r\\n'));
  out.http = await ctx.net.secure(s1, tls).then(() => 'served', (e) => e.code);
  await http.close();
  const a2 = plain.accept();
  const quiet = await ctx.net.connect({ port: plain.port });
  const s2 = await a2;
  out.timeout = await ctx.net.secure(s2, { ...tls, handshakeTimeout: 200 }).then(() => 'served', (e) => e.code);
  const w = s2.writable.getWriter();
  await w.write(enc.encode('HTTP/1.1 408 Request Timeout\\r\\n\\r\\n'));
  await w.close();
  out.afterTimeout = (await drain(quiet.readable)).split('\\r\\n')[0];
  await s2.close();
  await plain.close();
  const l = await ctx.net.listen({ tls: { cert: o.cert, key: o.key } });
  const next = l.accept();
  const bad = await ctx.net.connect({ port: l.port });
  const bw = bad.writable.getWriter();
  await bw.write(enc.encode('GET / HTTP/1.1\\r\\nhost: x\\r\\n\\r\\n'));
  out.listenerDrops = (await drain(bad.readable)).length;
  const good = await ctx.net.connect({ host: 'localhost', port: l.port, tls: { ca: o.cert } });
  out.listenerNext = (await next).tls.servername;
  await good.close();
  await l.close();
  ctx.write(1, JSON.stringify(out) + '\\n');
  return 0;
}
`;

const SELECT = `${SHARED}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hello(c) {
  const r = c.readable.getReader();
  await r.read().catch(() => undefined);
  r.releaseLock();
  const w = c.writable.getWriter();
  await w.write(enc.encode('hi from ' + c.tls.servername));
  await w.close();
}
async function dial(ctx, port, tls) {
  try {
    const c = await ctx.net.connect({ host: 'localhost', port, tls });
    const w = c.writable.getWriter();
    await w.write(enc.encode('x'));
    const text = await drain(c.readable);
    return { text, alpn: c.tls.alpnProtocol, leaf: b64(c.tls.peerCertificates[0]) };
  } catch (err) {
    return { error: failure(err) };
  }
}
async function child(ctx, o) {
  let c;
  for (let i = 0; i < 20; i++) c = await ctx.net.tlsContext({ cert: o.c.cert, key: o.c.key });
  await ctx.fs.writeFile('/tmp/child-ctx', String(c.fd));
  while (!(await ctx.fs.exists('/tmp/child-done'))) await sleep(10);
  return 0;
}
export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  if (o.child) return child(ctx, o);
  const out = {};
  const a = await ctx.net.tlsContext({ cert: o.a.cert, key: o.a.key });
  const b = await ctx.net.tlsContext({ cert: o.b.cert, key: o.b.key });
  const kid = await ctx.spawn({ argv: ['tlsselect', JSON.stringify({ child: true, c: o.c })] });
  while (!(await ctx.fs.exists('/tmp/child-ctx'))) await sleep(10);
  const foreign = Number(dec.decode(await ctx.fs.readFile('/tmp/child-ctx')));
  out.foreignFd = foreign;
  const seen = [];
  const errors = [];
  const l = await ctx.net.listen({
    tls: {
      handshakeTimeout: 400,
      select: async ({ servername, protocols }) => {
        seen.push({ servername, protocols });
        if (servername === 'a.test') return { context: a, alpn: protocols.at(-1) };
        if (servername === 'b.test') return { context: b };
        if (servername === 'nope.test') return { refuse: 'unrecognized_name' };
        if (servername === 'throw.test') throw new Error('select failed');
        if (servername === 'foreign.test') return { context: foreign };
        if (servername === 'listener.test') return { context: l.fd };
        await new Promise(() => {});
      },
    },
  });
  const serving = (async () => {
    for (;;) {
      let c;
      try {
        c = await l.accept();
      } catch {
        return;
      }
      void hello(c);
    }
  })();
  out.a = await dial(ctx, l.port, { ca: o.a.cert, servername: 'a.test', alpn: ['h2', 'http/1.1'] });
  out.b = await dial(ctx, l.port, { ca: o.b.cert, servername: 'b.test' });
  out.nope = await dial(ctx, l.port, { ca: o.a.cert, servername: 'nope.test' });
  out.thrown = await dial(ctx, l.port, { ca: o.a.cert, servername: 'throw.test' });
  out.foreign = await dial(ctx, l.port, { ca: o.c.cert, servername: 'foreign.test' });
  out.listenerFd = await dial(ctx, l.port, { ca: o.a.cert, servername: 'listener.test' });
  out.silent = await dial(ctx, l.port, { ca: o.a.cert, servername: 'silent.test' });
  out.after = await dial(ctx, l.port, { ca: o.b.cert, servername: 'b.test' });
  out.seen = seen.map((s) => s.servername);
  out.offered = seen[0].protocols;
  await l.close();
  await serving;
  const plain = await ctx.net.listen({});
  const acc = plain.accept();
  const peer = dial(ctx, plain.port, { ca: o.c.cert, servername: 'foreign.test' });
  const raw = await acc;
  out.secureForeign = await ctx.net
    .secure(raw, { server: true, select: () => ({ context: foreign }) })
    .then(() => 'served', (e) => e.code);
  out.secureForeignClient = Boolean((await peer).error);
  await plain.close();
  out.both = await ctx.net
    .listen({ tls: { alpn: ['h2'], select: () => ({}) } })
    .then(() => 'listened', (e) => e.detail);
  const many = [a, b];
  let refused;
  for (let i = 0; i < 70 && !refused; i++) {
    try {
      many.push(await ctx.net.tlsContext({ cert: o.a.cert, key: o.a.key }));
    } catch (err) {
      refused = err.code;
    }
  }
  out.count = many.length;
  out.refused = refused;
  await many.pop().close();
  out.again = await ctx.net.tlsContext({ cert: o.a.cert, key: o.a.key }).then(() => 'ok', (e) => e.code);
  await ctx.fs.writeFile('/tmp/child-done', '');
  await kid.wait();
  ctx.write(1, JSON.stringify(out) + '\\n');
  return 0;
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

async function kernelWith(t) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-tls-engine');
  await kernel.writeFile('/node_modules/tlsd/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/tlsd/bin/tlsd.mjs', SERVER);
  await kernel.writeFile('/node_modules/tlsd/bin/tlsc.mjs', CLIENT);
  await kernel.writeFile('/node_modules/tlsd/bin/tlsone.mjs', ONE);
  return async (o) => {
    const r = await kernel.run(['tlsd', JSON.stringify(o)], { cwd: '/' });
    assert.equal(r.stderr, '');
    const lines = r.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return {
      server: lines.filter((l) => l.server).map((l) => l.server),
      clients: Object.fromEntries(lines.filter((l) => l.client).map((l) => [l.client, l])),
    };
  };
}

function encrypted(key, passphrase, cipher = 'aes-256-cbc') {
  return createPrivateKey(key).export({ type: 'pkcs8', format: 'pem', cipher, passphrase });
}

const derOf = (pem) => new X509Certificate(pem).raw.toString('base64');

test(
  'a JS program serves HTTPS with its own self-signed cert and key, and another JS program fetches it with that cert as ca; ALPN is the server preference the client offers, servername is the SNI, and both sides report the same cipher (#1401, #1500)',
  TIMEOUT,
  async (t) => {
    const run = await kernelWith(t);
    const own = selfSigned('localhost');
    const { server, clients } = await run({
      tls: { cert: own.cert, key: own.key, alpn: ['h2', 'http/1.1'] },
      clients: [{ name: 'a', tls: { ca: own.cert, alpn: ['http/1.1'] } }],
    });
    assert.equal(clients.a.status, 'HTTP/1.1 200 OK', JSON.stringify(clients.a));
    assert.equal(clients.a.body, 'hello');
    assert.equal(clients.a.tls.authorized, true);
    assert.equal(clients.a.tls.alpnProtocol, 'http/1.1');
    assert.equal(clients.a.tls.substitutes, false);
    assert.equal(clients.a.tls.peerCertificates[0], derOf(own.cert));
    assert.equal(server.length, 1);
    assert.equal(server[0].line, 'GET /x HTTP/1.1');
    assert.equal(server[0].tls.path, 'kernel');
    assert.equal(server[0].tls.servername, 'localhost');
    assert.equal(server[0].tls.alpnProtocol, 'http/1.1');
    assert.equal(server[0].tls.authorized, false);
    assert.deepEqual(server[0].tls.peerCertificates, []);
    assert.ok(server[0].tls.cipher?.name, JSON.stringify(server[0].tls));
    assert.deepEqual(server[0].tls.cipher, clients.a.tls.cipher);
  }
);

test(
  'a loopback client without ca refuses a self-signed server, listen({ tls }) keeps accepting after that failed handshake, secure(conn, { server: true }) secures an accepted connection, and sync.net.listen takes tls too (#1401)',
  TIMEOUT,
  async (t) => {
    const run = await kernelWith(t);
    const own = selfSigned('localhost');
    const tls = { cert: own.cert, key: own.key };
    const listened = await run({
      tls,
      clients: [
        { name: 'untrusting', tls: {} },
        { name: 'b', tls: { ca: own.cert } },
      ],
    });
    assert.equal(
      listened.clients.untrusting.error?.code,
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      JSON.stringify(listened.clients.untrusting)
    );
    assert.equal(listened.clients.b.body, 'hello', JSON.stringify(listened.clients.b));
    assert.equal(listened.server.length, 1);
    assert.equal(listened.server[0].tls.servername, 'localhost');
    const secured = await run({
      mode: 'secure',
      tls,
      clients: [{ name: 'c', tls: { ca: own.cert, servername: 'localhost' } }],
    });
    assert.equal(secured.clients.c.body, 'hello', JSON.stringify(secured));
    assert.equal(secured.server[0].tls.protocol, secured.clients.c.tls.protocol);
    const synced = await run({
      mode: 'sync',
      tls,
      clients: [{ name: 'd', host: '127.0.0.1', tls: { ca: own.cert, servername: 'localhost' } }],
    });
    assert.equal(synced.clients.d.body, 'hello', JSON.stringify(synced));
    assert.equal(synced.server[0].tls.servername, 'localhost');
  }
);

test(
  'a wrong passphrase and a key that is not the cert key are refused at listen with the client-cert errors, and the refusal carries no key or passphrase bytes (#1401)',
  TIMEOUT,
  async (t) => {
    const run = await kernelWith(t);
    const own = selfSigned('localhost');
    const other = selfSigned('localhost');
    const locked = encrypted(own.key, 'right horse battery');
    const wrong = await run({
      tls: { cert: own.cert, key: locked, passphrase: 'wrong staple' },
      clients: [],
    });
    const refused = wrong.server[0].listen;
    assert.equal(refused.code, 'ERR_OSSL_BAD_DECRYPT', JSON.stringify(refused));
    const body = locked.split('\n').slice(1, -2).join('');
    const text = JSON.stringify(refused);
    for (const secret of ['right horse', 'wrong staple', body.slice(0, 24), body.slice(-24)])
      assert.ok(!text.includes(secret), `the refusal shows ${secret}`);
    const mismatch = await run({ tls: { cert: own.cert, key: other.key }, clients: [] });
    assert.equal(mismatch.server[0].listen.code, 'ERR_OSSL_X509_KEY_VALUES_MISMATCH');
    assert.match(mismatch.server[0].listen.detail, /the key does not match the certificate$/);
  }
);

test(
  'a PKCS#8 key under PBES2 with Camellia or ARIA serves with its passphrase and is ERR_OSSL_BAD_DECRYPT with a wrong one, and one under 3DES is ERR_OSSL_UNSUPPORTED either way, as Mbed TLS 4 has no DES (#1564)',
  TIMEOUT,
  async (t) => {
    const run = await kernelWith(t);
    const own = selfSigned('localhost');
    const ciphers = ['camellia-128-cbc', 'camellia-192-cbc', 'camellia-256-cbc'];
    ciphers.push('aria-128-cbc', 'aria-192-cbc', 'aria-256-cbc');
    for (const cipher of ciphers) {
      const key = encrypted(own.key, 'correct horse', cipher);
      const served = await run({
        tls: { cert: own.cert, key, passphrase: 'correct horse' },
        clients: [{ name: 'a', tls: { ca: own.cert } }],
      });
      assert.equal(served.clients.a.body, 'hello', `${cipher} ${JSON.stringify(served)}`);
      const wrong = await run({
        tls: { cert: own.cert, key, passphrase: 'battery staple' },
        clients: [],
      });
      assert.equal(
        wrong.server[0].listen?.code,
        'ERR_OSSL_BAD_DECRYPT',
        `${cipher} ${JSON.stringify(wrong)}`
      );
    }
    const des = encrypted(own.key, 'correct horse', 'des-ede3-cbc');
    for (const passphrase of ['correct horse', 'battery staple']) {
      const refused = await run({ tls: { cert: own.cert, key: des, passphrase }, clients: [] });
      assert.equal(refused.server[0].listen?.code, 'ERR_OSSL_UNSUPPORTED', JSON.stringify(refused));
    }
  }
);

test(
  'requestCert with rejectUnauthorized refuses a client with no certificate and admits one the ca issued, shown in peerCertificates (#1401)',
  TIMEOUT,
  async (t) => {
    const run = await kernelWith(t);
    const own = selfSigned('localhost');
    const ca = makeCa();
    const mine = ca.rsaClient('client.test');
    const { server, clients } = await run({
      tls: { cert: own.cert, key: own.key, ca: ca.pem, requestCert: true },
      clients: [
        { name: 'anonymous', tls: { ca: own.cert } },
        { name: 'known', tls: { ca: own.cert, cert: mine.cert, key: mine.key } },
      ],
    });
    assert.ok(clients.anonymous.error, JSON.stringify(clients.anonymous));
    assert.equal(clients.known.body, 'hello', JSON.stringify(clients.known));
    const admitted = server.find((s) => s.tls);
    assert.equal(admitted.tls.authorized, true);
    assert.equal(admitted.tls.peerCertificates[0], Buffer.from(mine.der).toString('base64'));
    assert.equal(server.length, 1, JSON.stringify(server));
  }
);

test(
  'handshakes never hold the program: a client in the same program, an idle connection ahead of a real client, an aborted accept, a handshake timeout and an aborted loopback client all leave the program running (#1401)',
  TIMEOUT,
  async (t) => {
    const kernel = await createNodeKernel({ users: 'off' });
    t.after(() => kernel.terminate());
    await install(kernel, 'wasm-tls-engine');
    await kernel.writeFile('/node_modules/tlsd/package.json', PACKAGE);
    await kernel.writeFile('/node_modules/tlsd/bin/tlsone.mjs', ONE);
    const own = selfSigned('localhost');
    const r = await kernel.run(['tlsone', JSON.stringify({ cert: own.cert, key: own.key })], {
      cwd: '/',
    });
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), {
      same: 'ok',
      sameEcho: 'same',
      afterIdle: 'ok',
      aliveAfterIdle: 'yes',
      idleEcho: 'next',
      aborted: 'This operation was aborted',
      aliveAfterAbort: 'yes',
      timeout: 'ERR_TLS_HANDSHAKE_TIMEOUT',
      clientAbort: 'refused',
      aliveAfterClient: 'yes',
    });
  }
);

test(
  'secure({ server: true }) refuses a plain HTTP request with ERR_SSL_HTTP_REQUEST, and a handshake timeout leaves the connection to the program, as Node with tlsClientError; a listener drops both and keeps accepting (#1504)',
  TIMEOUT,
  async (t) => {
    const kernel = await createNodeKernel({ users: 'off' });
    t.after(() => kernel.terminate());
    await install(kernel, 'wasm-tls-engine');
    await kernel.writeFile('/node_modules/tlsd/package.json', PACKAGE);
    await kernel.writeFile('/node_modules/tlsd/bin/tlsparity.mjs', PARITY);
    const own = selfSigned('localhost');
    const r = await kernel.run(['tlsparity', JSON.stringify({ cert: own.cert, key: own.key })], {
      cwd: '/',
    });
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), {
      http: 'ERR_SSL_HTTP_REQUEST',
      timeout: 'ERR_TLS_HANDSHAKE_TIMEOUT',
      afterTimeout: 'HTTP/1.1 408 Request Timeout',
      listenerDrops: 0,
      listenerNext: 'localhost',
    });
  }
);

test(
  'requestCert without ca checks a client certificate against the bundled roots: a self-signed one is refused, and only reported with rejectUnauthorized: false (#1503)',
  TIMEOUT,
  async (t) => {
    const run = await kernelWith(t);
    const own = selfSigned('localhost');
    const stranger = selfSigned('client.test');
    const client = { ca: own.cert, cert: stranger.cert, key: stranger.key };
    const strict = await run({
      tls: { cert: own.cert, key: own.key, requestCert: true },
      clients: [{ name: 'self', tls: client }],
    });
    assert.equal(strict.server.length, 0, JSON.stringify(strict));
    assert.ok(strict.clients.self.error, JSON.stringify(strict.clients.self));
    const loose = await run({
      tls: { cert: own.cert, key: own.key, requestCert: true, rejectUnauthorized: false },
      clients: [{ name: 'self', tls: client }],
    });
    assert.equal(loose.clients.self.body, 'hello', JSON.stringify(loose));
    assert.equal(loose.server[0].tls.authorized, false);
    assert.ok(loose.server[0].tls.authorizationError);
    assert.equal(loose.server[0].tls.peerCertificates.length, 1);
  }
);

test(
  "a kernel server refusing a loopback client's certificate sends an alert the client reads: 116 for none and the verifier's alert for an untrusted one, not a MAC failure (#1499, tls-engine 4.2.0-9)",
  TIMEOUT,
  async (t) => {
    const run = await kernelWith(t);
    const own = selfSigned('localhost');
    const ca = makeCa();
    const stranger = makeCa('another client CA').rsaClient('client.test');
    const { clients } = await run({
      tls: { cert: own.cert, key: own.key, ca: ca.pem, requestCert: true },
      clients: [
        { name: 'none', tls: { ca: own.cert } },
        { name: 'untrusted', tls: { ca: own.cert, cert: stranger.cert, key: stranger.key } },
      ],
    });
    assert.equal(clients.none.error?.code, 'ERR_SSL_FATAL_ALERT', JSON.stringify(clients.none));
    assert.equal(clients.none.error.alert, 116);
    assert.equal(
      clients.untrusted.error?.code,
      'ERR_SSL_FATAL_ALERT',
      JSON.stringify(clients.untrusted)
    );
    assert.equal(clients.untrusted.error.alert, 48);
  }
);

test('select picks a certificate by SNI and ALPN from the client offer, refuses with an alert, drops a throwing or silent select, and never uses a context the process does not hold: EBADF for another process context or a non-context fd; 64 contexts per process (#1501, #1502)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-tls-engine');
  await kernel.writeFile('/node_modules/tlsd/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/tlsd/bin/tlsselect.mjs', SELECT);
  const a = selfSigned('a.test');
  const b = selfSigned('b.test');
  const c = selfSigned('foreign.test');
  const r = await kernel.run(['tlsselect', JSON.stringify({ a, b, c })], { cwd: '/' });
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  const der = (cert) => new X509Certificate(cert.cert).raw.toString('base64');
  assert.deepEqual(out.a, { text: 'hi from a.test', alpn: 'http/1.1', leaf: der(a) });
  assert.deepEqual(out.offered, ['h2', 'http/1.1']);
  assert.equal(out.b.leaf, der(b));
  assert.equal(out.b.alpn, false);
  assert.match(out.nope.error.detail, /\(alert 112\)$/, JSON.stringify(out.nope));
  assert.ok(out.thrown.error, JSON.stringify(out.thrown));
  assert.ok(out.foreign.error, JSON.stringify(out.foreign));
  assert.ok(out.listenerFd.error, JSON.stringify(out.listenerFd));
  assert.ok(out.silent.error, JSON.stringify(out.silent));
  assert.equal(out.after.leaf, der(b));
  assert.deepEqual(out.seen, [
    'a.test',
    'b.test',
    'nope.test',
    'throw.test',
    'foreign.test',
    'listener.test',
    'silent.test',
    'b.test',
  ]);
  assert.equal(out.secureForeign, 'EBADF');
  assert.match(out.both, /^ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS/);
  assert.equal(out.count, 64);
  assert.equal(out.refused, 'EMFILE');
  assert.equal(out.again, 'ok');
});

test(
  'keylog: true gives a session its NSS key log lines, the five of TLS 1.3 with EXPORTER_SECRET as Node 22, the same on the kernel server and the loopback client, and a session without it has none (#1504, #1545)',
  TIMEOUT,
  async (t) => {
    const run = await kernelWith(t);
    const own = selfSigned('localhost');
    const { server, clients } = await run({
      tls: { cert: own.cert, key: own.key, keylog: true },
      clients: [
        { name: 'logged', tls: { ca: own.cert, keylog: true } },
        { name: 'plain', tls: { ca: own.cert } },
      ],
    });
    const logged = clients.logged.tls.keylog;
    assert.equal(logged.length, 5, JSON.stringify(clients.logged));
    assert.deepEqual(logged.map((line) => line.split(' ')[0]).sort(), [
      'CLIENT_HANDSHAKE_TRAFFIC_SECRET',
      'CLIENT_TRAFFIC_SECRET_0',
      'EXPORTER_SECRET',
      'SERVER_HANDSHAKE_TRAFFIC_SECRET',
      'SERVER_TRAFFIC_SECRET_0',
    ]);
    assert.ok(logged.every((line) => line.split(' ')[1] === logged[0].split(' ')[1]));
    const random = logged[0].split(' ')[1];
    const mine = server.find((s) => s.tls.keylog.some((l) => l.includes(random)));
    assert.deepEqual([...mine.tls.keylog].sort(), [...logged].sort());
    assert.equal(clients.plain.tls.keylog, undefined);
    assert.equal(server.length, 2);
  }
);
