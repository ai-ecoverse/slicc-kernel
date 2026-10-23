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
    },
  },
});

const SHARED = `const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (v) => btoa(String.fromCharCode(...v));
const shown = (tls) => tls && JSON.parse(JSON.stringify(tls, (k, v) => (v instanceof Uint8Array ? b64(v) : v)));
const failure = (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? '' });
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

function encrypted(key, passphrase) {
  return createPrivateKey(key).export({
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase,
  });
}

const derOf = (pem) => new X509Certificate(pem).raw.toString('base64');

test(
  'a JS program serves HTTPS with its own self-signed cert and key, and another JS program fetches it with that cert as ca; ALPN is the server preference the client offers and servername is the SNI (#1401)',
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
