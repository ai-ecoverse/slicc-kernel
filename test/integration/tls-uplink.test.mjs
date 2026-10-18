import assert from 'node:assert/strict';
import { createHash, createPrivateKey } from 'node:crypto';
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
const TIMEOUT = { timeout: 60_000 };

const PACKAGE = JSON.stringify({
  name: 'tlsup',
  slicc: { commands: { tlsup: { abi: 'js', module: 'bin/tlsup.mjs' } } },
});

const PROGRAM = `const enc = new TextEncoder();
const dec = new TextDecoder();
async function line(reader) {
  let text = '';
  while (!text.includes('\\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  return text;
}
async function dump(ctx, c, text) {
  const seen = [];
  for (const key in c) seen.push(key);
  const proc = [];
  const walk = async (dir, depth) => {
    for (const name of await ctx.fs.readdir(dir).catch(() => [])) {
      const path = dir + '/' + name;
      const body = await ctx.fs.readFile(path).catch(() => undefined);
      if (body !== undefined) proc.push(path + '\\n' + text(body));
      else if (depth > 0) await walk(path, depth - 1);
    }
  };
  await walk('/proc', 1);
  const tls = JSON.stringify(c.tls, (k, v) => (v instanceof Uint8Array ? btoa(String.fromCharCode(...v)) : v));
  return { keys: seen, tls, proc: proc.join('\\n') };
}
export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  if (o.derCa) o.tls.ca = [Uint8Array.from(atob(o.derCa), (ch) => ch.charCodeAt(0))];
  const text = (v) => (typeof v === 'string' ? v : dec.decode(v));
  if (o.keyFile) o.tls.key = text(await ctx.fs.readFile(o.keyFile));
  if (o.passFile) o.tls.passphrase = text(await ctx.fs.readFile(o.passFile));
  const say = (v) => ctx.write(1, JSON.stringify(v) + '\\n');
  try {
    let c;
    if (o.starttls) {
      const plain = await ctx.net.connect({ host: o.host, port: o.port });
      const w = plain.writable.getWriter();
      await w.write(enc.encode('STARTTLS\\r\\n'));
      const r = plain.readable.getReader();
      const ok = await line(r);
      r.releaseLock();
      w.releaseLock();
      if (ok.trim() !== 'OK') return say({ error: 'no OK: ' + ok });
      c = await ctx.net.connect({ socket: plain, host: o.host, tls: o.tls });
    } else {
      c = await ctx.net.connect({ host: o.host, port: o.port, tls: o.tls });
    }
    const { peerCertificates, ...tls } = c.tls;
    const out = { tls, peers: (peerCertificates ?? []).length };
    if (o.send) {
      const w = c.writable.getWriter();
      await w.write(enc.encode(o.send + '\\n'));
      out.echo = (await line(c.readable.getReader())).trim();
    }
    if (o.dump) out.dump = await dump(ctx, c, text);
    if (peerCertificates?.length) out.leafSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', peerCertificates[0]))).map((b) => b.toString(16).padStart(2, '0')).join('');
    await say(out);
    await c.close();
  } catch (e) {
    await say({ code: e.code, detail: e.detail, message: e.message, stack: e.stack });
  }
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

function transport() {
  const seen = [];
  return {
    seen,
    traits: {
      manualRedirects: false,
      encodedBodies: false,
      maxRequestBody: 1 << 20,
      websocket: false,
    },
    async fetch(req) {
      seen.push(req.url);
      const body = new TextEncoder().encode('via transport\n');
      return {
        status: 200,
        statusText: 'OK',
        headers: [['content-length', String(body.length)]],
        body: (async function* () {
          yield body;
        })(),
        cancel: async () => {},
      };
    },
  };
}

const ca = makeCa();
const other = makeCa('another CA');

function pipeTo(port) {
  return (p) => {
    const sock = tcp(port, '127.0.0.1');
    sock.on('data', (d) => p.write(new Uint8Array(d)));
    sock.on('end', () => p.end());
    sock.on('error', () => p.end());
    void (async () => {
      for (;;) {
        const bytes = await p.read().catch(() => null);
        if (!bytes) {
          sock.end();
          return;
        }
        sock.write(bytes);
      }
    })();
  };
}

const echo = (s) => s.on('data', (d) => s.write(d));

async function tlsServer(t, cert, options = {}) {
  const server = createServer({ key: cert.key, cert: cert.cert, ...options }, echo);
  server.on('tlsClientError', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return server.address().port;
}

async function startTlsServer(t, cert) {
  const server = createTcp((sock) => {
    sock.once('data', () => {
      sock.write('OK\r\n');
      const secure = new TLSSocket(sock, { isServer: true, key: cert.key, cert: cert.cert });
      secure.on('error', () => {});
      echo(secure);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return server.address().port;
}

async function kernelWith(t, servers) {
  const names = {};
  const peers = {};
  const dials = { count: 0 };
  servers.forEach(([host, port], i) => {
    const address = /^\d/.test(host) ? host : `203.0.113.${10 + i}`;
    if (address !== host) names[host] = [address];
    const pipe = pipeTo(port);
    for (const p of [4433, 465, 443, 2525]) {
      peers[`${address}:${p}`] = (conn) => {
        dials.count++;
        pipe(conn);
      };
    }
  });
  const uplink = fakeUplink({ routes: { prefixes: [], exit: true }, names, peers });
  const tr = transport();
  const kernel = await createNodeKernel({ users: 'off', network: { uplink, transport: tr } });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-tls-engine');
  await kernel.writeFile('/node_modules/tlsup/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/tlsup/bin/tlsup.mjs', PROGRAM);
  const run = async (o) => {
    const r = await kernel.run(['tlsup', JSON.stringify(o)], { cwd: '/' });
    assert.equal(r.stderr, '');
    return JSON.parse(r.stdout);
  };
  return { run, uplink, transport: tr, dials, kernel };
}

const sha = (der) => createHash('sha256').update(der).digest('hex');

test(
  'a custom ca takes the TLS handshake into the kernel over the uplink: TLS 1.3 and 1.2 verified, with the real session (#922)',
  TIMEOUT,
  async (t) => {
    const leaf = ca.server('secure.test');
    const v13 = await tlsServer(t, leaf, { minVersion: 'TLSv1.3', ALPNProtocols: ['h2'] });
    const v12 = await tlsServer(t, leaf, { maxVersion: 'TLSv1.2' });
    const { run } = await kernelWith(t, [
      ['secure.test', v13],
      ['old.test', v12],
    ]);
    const got = await run({
      host: 'secure.test',
      port: 4433,
      tls: { ca: ca.pem, alpn: ['h2', 'http/1.1'] },
      send: 'ping',
    });
    assert.deepEqual(got, {
      tls: {
        path: 'kernel',
        substitutes: false,
        protocol: 'TLSv1.3',
        alpnProtocol: 'h2',
        authorized: true,
        servername: 'secure.test',
        cipher: {
          name: 'TLS_AES_256_GCM_SHA384',
          standardName: 'TLS_AES_256_GCM_SHA384',
          version: 'TLSv1.3',
        },
        clientCertificate: false,
        sni: true,
        hostnameChecked: true,
        hostnameMatches: true,
      },
      peers: 2,
      echo: 'ping',
      leafSha: sha(leaf.der),
    });
    const old = await run({
      host: 'old.test',
      port: 4433,
      tls: { ca: ca.pem, servername: 'secure.test' },
      send: 'ping',
    });
    assert.equal(old.tls.protocol, 'TLSv1.2');
    assert.equal(old.tls.alpnProtocol, false);
    assert.equal(old.echo, 'ping');
  }
);

test(
  'the kernel refuses a wrong host, an untrusted CA and an expired leaf with Node codes, and rejectUnauthorized: false connects and reports why (#922)',
  TIMEOUT,
  async (t) => {
    const day = 86400_000;
    const wrong = await tlsServer(t, ca.server('other.test'));
    const untrusted = await tlsServer(t, other.server('secure.test'));
    const expired = await tlsServer(
      t,
      ca.server('secure.test', {
        notBefore: new Date(Date.now() - 3 * day),
        notAfter: new Date(Date.now() - day),
      })
    );
    const { run } = await kernelWith(t, [
      ['wrong.test', wrong],
      ['untrusted.test', untrusted],
      ['expired.test', expired],
    ]);
    const tls = { ca: ca.pem, servername: 'secure.test' };
    assert.equal(
      (await run({ host: 'wrong.test', port: 4433, tls })).code,
      'ERR_TLS_CERT_ALTNAME_INVALID'
    );
    assert.equal(
      (await run({ host: 'untrusted.test', port: 4433, tls })).code,
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    );
    assert.equal((await run({ host: 'expired.test', port: 4433, tls })).code, 'CERT_HAS_EXPIRED');
    const insecure = await run({
      host: 'untrusted.test',
      port: 4433,
      tls: { ...tls, rejectUnauthorized: false },
      send: 'hi',
    });
    assert.equal(insecure.tls.authorized, false);
    assert.equal(insecure.tls.authorizationError, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    assert.equal(insecure.echo, 'hi');
  }
);

test(
  'without a ca the kernel verifies against the bundled roots, which a test CA is not in; a non-HTTP port and path: kernel take the kernel path too (#922)',
  TIMEOUT,
  async (t) => {
    const port = await tlsServer(t, ca.server('secure.test'));
    const { run } = await kernelWith(t, [['secure.test', port]]);
    assert.equal(
      (await run({ host: 'secure.test', port: 465, tls: {} })).code,
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    );
    assert.equal(
      (await run({ host: 'secure.test', port: 443, tls: { path: 'kernel' } })).code,
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    );
    const ok = await run({
      host: 'secure.test',
      port: 465,
      tls: {},
      derCa: Buffer.from(ca.der).toString('base64'),
      send: 'x',
    });
    assert.equal(ok.tls.path, 'kernel');
    assert.equal(ok.echo, 'x');
  }
);

test(
  'an uplinked host on 443 with default options keeps the transport path, with substitution (#922)',
  TIMEOUT,
  async (t) => {
    const port = await tlsServer(t, ca.server('secure.test'));
    const { run, transport: tr, uplink } = await kernelWith(t, [['secure.test', port]]);
    const got = await run({ host: 'secure.test', port: 443, tls: {} });
    assert.deepEqual(got.tls, {
      path: 'transport',
      substitutes: true,
      protocol: 'transport',
      alpnProtocol: 'http/1.1',
      authorized: true,
      servername: 'secure.test',
    });
    assert.deepEqual(uplink.dialled, []);
    assert.deepEqual(tr.seen, []);
  }
);

test(
  'STARTTLS: ctx.net.connect({ socket, tls }) upgrades a plain uplink connection in the kernel (#922)',
  TIMEOUT,
  async (t) => {
    const leaf = ca.server('mail.test');
    const port = await startTlsServer(t, leaf);
    const { run } = await kernelWith(t, [['mail.test', port]]);
    const got = await run({
      starttls: true,
      host: 'mail.test',
      port: 2525,
      tls: { ca: ca.pem },
      send: 'EHLO',
    });
    assert.equal(got.tls?.path, 'kernel', JSON.stringify(got));
    assert.equal(got.tls.authorized, true);
    assert.equal(got.tls.servername, 'mail.test');
    assert.equal(got.echo, 'EHLO');
    assert.equal(got.leafSha, sha(leaf.der));
  }
);

test(
  'server names are checked before anything is dialled, and an IP literal verifies against an iPAddress SAN (#922)',
  TIMEOUT,
  async (t) => {
    const ipPort = await tlsServer(t, ca.server('192.0.2.7'));
    const { run, uplink } = await kernelWith(t, [['192.0.2.7', ipPort]]);
    for (const servername of [
      'bad\u0000name.test',
      'a_b.test',
      `${'a'.repeat(64)}.test`,
      `${'abc.'.repeat(64)}test`,
      '-x.test',
    ]) {
      assert.equal(
        (await run({ host: '192.0.2.7', port: 4433, tls: { ca: ca.pem, servername } })).code,
        'EINVAL',
        servername
      );
    }
    assert.deepEqual(uplink.dialled, []);
    const ip = await run({ host: '192.0.2.7', port: 4433, tls: { ca: ca.pem }, send: 'ip' });
    assert.equal(ip.tls.authorized, true, JSON.stringify(ip));
    assert.equal(ip.echo, 'ip');
    const dot = await run({
      host: '192.0.2.7',
      port: 4433,
      tls: { ca: ca.pem, servername: '192.0.2.7' },
    });
    assert.equal(dot.tls.servername, '192.0.2.7');
  }
);

test(
  'a custom ca with no certificate in it is refused, and a non-uplink destination with a ca stays ENOTSUP (#922)',
  TIMEOUT,
  async (t) => {
    const { run } = await kernelWith(t, []);
    assert.equal(
      (await run({ host: 'localhost', port: 4433, tls: { ca: ca.pem } })).code,
      'ENOTSUP'
    );
    const port = await tlsServer(t, ca.server('secure.test'));
    const k = await kernelWith(t, [['secure.test', port]]);
    assert.equal(
      (await k.run({ host: 'secure.test', port: 4433, tls: { ca: 'not a pem' } })).code,
      'EINVAL'
    );
  }
);

const clientCa = makeCa('client CA');
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

function encrypted(key, passphrase) {
  return createPrivateKey(key).export({
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase,
  });
}

async function recordingServer(t, cert, options = {}) {
  const seen = [];
  const server = createServer({ key: cert.key, cert: cert.cert, ...options }, (s) => {
    const peer = s.getPeerCertificate();
    seen.push({ cipher: s.getCipher(), servername: s.servername, peer: peer?.subject?.CN });
    s.on('data', (d) => s.write(`${peer?.subject?.CN ?? 'anonymous'} ${d}`));
  });
  server.on('tlsClientError', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, seen };
}

test(
  'conn.tls reports the negotiated cipher the server agreed, on TLS 1.3 and 1.2 (#1004)',
  TIMEOUT,
  async (t) => {
    const leaf = ca.server('secure.test');
    const v13 = await recordingServer(t, leaf, { minVersion: 'TLSv1.3' });
    const v12 = await recordingServer(t, leaf, { maxVersion: 'TLSv1.2' });
    const { run } = await kernelWith(t, [
      ['secure.test', v13.port],
      ['old.test', v12.port],
    ]);
    const tls = { ca: ca.pem, servername: 'secure.test' };
    for (const [host, server, version] of [
      ['secure.test', v13, 'TLSv1.3'],
      ['old.test', v12, 'TLSv1.2'],
    ]) {
      const got = await run({ host, port: 4433, tls, send: 'hi' });
      const { name, standardName } = server.seen[0].cipher;
      assert.deepEqual(got.tls.cipher, { name, standardName, version });
      assert.equal(got.tls.clientCertificate, false);
      assert.equal(got.tls.sni, true);
      assert.equal(got.tls.hostnameChecked, true);
      assert.equal(got.tls.hostnameMatches, true);
    }
  }
);

test(
  'mTLS: cert and key present a client certificate the server requires; without one the server refuses, and an encrypted key needs its passphrase (#1004)',
  TIMEOUT,
  async (t) => {
    const mine = clientCa.server('kernel client', { eku: CLIENT_AUTH });
    const strict = await recordingServer(t, ca.server('secure.test'), {
      requestCert: true,
      rejectUnauthorized: true,
      ca: clientCa.pem,
      minVersion: 'TLSv1.3',
    });
    const strict12 = await recordingServer(t, ca.server('secure.test'), {
      requestCert: true,
      rejectUnauthorized: true,
      ca: clientCa.pem,
      maxVersion: 'TLSv1.2',
    });
    const { run } = await kernelWith(t, [
      ['secure.test', strict.port],
      ['old.test', strict12.port],
    ]);
    const tls = { ca: ca.pem, servername: 'secure.test' };
    for (const host of ['secure.test', 'old.test']) {
      const ok = await run({
        host,
        port: 4433,
        tls: { ...tls, cert: mine.cert, key: mine.key },
        send: 'hi',
      });
      assert.equal(ok.echo, 'kernel client hi');
      assert.equal(ok.tls.clientCertificate, true);
      const refused = await run({ host, port: 4433, tls, send: 'hi' });
      assert.equal(
        refused.code,
        host === 'old.test' ? 'ERR_SSL_HANDSHAKE_FAILURE' : 'ERR_SSL_FATAL_ALERT'
      );
    }
    const locked = encrypted(mine.key, 'open sesame');
    const right = await run({
      host: 'secure.test',
      port: 4433,
      tls: { ...tls, cert: mine.cert, key: locked, passphrase: 'open sesame' },
      send: 'hi',
    });
    assert.equal(right.echo, 'kernel client hi');
  }
);

test(
  'a wrong passphrase, a missing one and a key that does not match the certificate are refused before anything is dialled (#1004)',
  TIMEOUT,
  async (t) => {
    const mine = clientCa.server('kernel client', { eku: CLIENT_AUTH });
    const stranger = clientCa.server('someone else', { eku: CLIENT_AUTH });
    const server = await recordingServer(t, ca.server('secure.test'));
    const { run, dials } = await kernelWith(t, [['secure.test', server.port]]);
    const tls = { ca: ca.pem, cert: mine.cert };
    const locked = encrypted(mine.key, 'open sesame');
    const cases = [
      [{ key: locked, passphrase: 'wrong' }, 'ERR_OSSL_BAD_DECRYPT'],
      [{ key: locked }, 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED'],
      [{ key: stranger.key }, 'ERR_OSSL_X509_KEY_VALUES_MISMATCH'],
      [{ key: 'not a key' }, 'ERR_OSSL_UNSUPPORTED'],
    ];
    for (const [extra, code] of cases) {
      const got = await run({ host: 'secure.test', port: 4433, tls: { ...tls, ...extra } });
      assert.equal(got.code, code);
    }
    assert.equal(dials.count, 0);
    assert.equal(
      (await run({ host: 'secure.test', port: 4433, tls: { ca: ca.pem, key: mine.key } })).code,
      'EINVAL'
    );
    assert.equal(
      (await run({ host: 'secure.test', port: 4433, tls: { ca: ca.pem, pfx: 'x' } })).code,
      'ENOTSUP'
    );
    assert.equal(dials.count, 0);
  }
);

test(
  'sni: false sends no server name and still refuses a leaf for another host (#1004)',
  TIMEOUT,
  async (t) => {
    const good = await recordingServer(t, ca.server('secure.test'));
    const wrong = await recordingServer(t, ca.server('other.test'));
    const { run } = await kernelWith(t, [
      ['secure.test', good.port],
      ['wrong.test', wrong.port],
    ]);
    const got = await run({
      host: 'secure.test',
      port: 4433,
      tls: { ca: ca.pem, sni: false },
      send: 'hi',
    });
    assert.equal(got.echo, 'anonymous hi');
    assert.equal(got.tls.sni, false);
    assert.equal(got.tls.hostnameMatches, true);
    assert.equal(good.seen[0].servername, false);
    const refused = await run({
      host: 'wrong.test',
      port: 4433,
      tls: { ca: ca.pem, servername: 'secure.test', sni: false },
    });
    assert.equal(refused.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  }
);

test(
  'checkHostname: false connects a leaf for another host and says it does not match, still refuses untrusted and expired chains, and is EINVAL with rejectUnauthorized: false (#1004)',
  TIMEOUT,
  async (t) => {
    const day = 86400_000;
    const wrong = await recordingServer(t, ca.server('other.test'));
    const untrusted = await recordingServer(t, other.server('secure.test'));
    const expired = await recordingServer(
      t,
      ca.server('secure.test', {
        notBefore: new Date(Date.now() - 3 * day),
        notAfter: new Date(Date.now() - day),
      })
    );
    const { run, dials } = await kernelWith(t, [
      ['wrong.test', wrong.port],
      ['untrusted.test', untrusted.port],
      ['expired.test', expired.port],
    ]);
    const tls = { ca: ca.pem, servername: 'secure.test', checkHostname: false };
    const got = await run({ host: 'wrong.test', port: 4433, tls, send: 'hi' });
    assert.equal(got.echo, 'anonymous hi');
    assert.equal(got.tls.authorized, true);
    assert.equal(got.tls.hostnameChecked, false);
    assert.equal(got.tls.hostnameMatches, false);
    assert.equal(got.peers, 2);
    assert.equal(
      (await run({ host: 'untrusted.test', port: 4433, tls })).code,
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    );
    assert.equal((await run({ host: 'expired.test', port: 4433, tls })).code, 'CERT_HAS_EXPIRED');
    const before = dials.count;
    assert.equal(
      (await run({ host: 'wrong.test', port: 4433, tls: { ...tls, rejectUnauthorized: false } }))
        .code,
      'EINVAL'
    );
    assert.equal(dials.count, before);
  }
);

test(
  'STARTTLS takes the client certificate too, and the new options on a destination the uplink does not route are ENOTSUP (#1004)',
  TIMEOUT,
  async (t) => {
    const mine = clientCa.server('kernel client', { eku: CLIENT_AUTH });
    const server = createTcp((sock) => {
      sock.once('data', () => {
        sock.write('OK\r\n');
        const secure = new TLSSocket(sock, {
          isServer: true,
          ...ca.server('secure.test'),
          requestCert: true,
          rejectUnauthorized: true,
          ca: clientCa.pem,
        });
        secure.on('error', () => {});
        secure.on('data', (d) => secure.write(`${secure.getPeerCertificate()?.subject?.CN} ${d}`));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const { run } = await kernelWith(t, [['mail.test', server.address().port]]);
    const got = await run({
      host: 'mail.test',
      port: 2525,
      starttls: true,
      tls: { ca: ca.pem, servername: 'secure.test', cert: mine.cert, key: mine.key },
      send: 'hi',
    });
    assert.equal(got.echo, 'kernel client hi');
    assert.equal(got.tls.clientCertificate, true);
    for (const extra of [
      { sni: false },
      { checkHostname: false },
      { cert: mine.cert, key: mine.key },
    ]) {
      assert.equal((await run({ host: 'localhost', port: 4433, tls: extra })).code, 'ENOTSUP');
    }
  }
);

test(
  'conn.tls.cipher.version is the suite version Node reports (TLSv1.0 for a CBC-SHA suite on a TLS 1.2 session), and an IP-literal servername reports sni: false as the server sees none (#1037)',
  TIMEOUT,
  async (t) => {
    const leaf = ca.server('secure.test');
    const cbc = await recordingServer(t, leaf, {
      maxVersion: 'TLSv1.2',
      ciphers: 'ECDHE-ECDSA-AES128-SHA',
    });
    const ip = await recordingServer(t, ca.server('192.0.2.7'));
    const { run } = await kernelWith(t, [
      ['secure.test', cbc.port],
      ['192.0.2.7', ip.port],
    ]);
    const got = await run({ host: 'secure.test', port: 4433, tls: { ca: ca.pem }, send: 'hi' });
    assert.equal(got.tls.protocol, 'TLSv1.2');
    assert.deepEqual(got.tls.cipher, cbc.seen[0].cipher);
    assert.equal(got.tls.cipher.version, 'TLSv1.0');
    const byIp = await run({ host: '192.0.2.7', port: 4433, tls: { ca: ca.pem }, send: 'hi' });
    assert.equal(byIp.tls.authorized, true);
    assert.equal(ip.seen[0].servername, false);
    assert.equal(byIp.tls.sni, false);
    assert.equal(byIp.tls.hostnameMatches, true);
  }
);

function captureOutput(t) {
  const chunks = [];
  const tap = (stream) => {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      chunks.push(String(chunk));
      return write(chunk, ...rest);
    };
    return () => {
      stream.write = write;
    };
  };
  const undo = [tap(process.stdout), tap(process.stderr)];
  t.after(() => {
    for (const u of undo) u();
  });
  return () => chunks.join('');
}

const PASS = 'zzy1049-passphrase-marker';

function keyMarkers(pem) {
  const body = pem.split('\n').filter((l) => l && !l.startsWith('-----'));
  return body.map((l) => l.slice(4, 28)).filter((m) => m.length === 24);
}

test(
  'a client key and its passphrase never come back: not on the connection, not in conn.tls, not in /proc, not in a refusal, not in anything the kernel prints (#1049)',
  TIMEOUT,
  async (t) => {
    const mine = clientCa.server('kernel client', { eku: CLIENT_AUTH });
    const stranger = clientCa.server('someone else', { eku: CLIENT_AUTH });
    const locked = encrypted(mine.key, PASS);
    const server = await recordingServer(t, ca.server('secure.test'), {
      requestCert: true,
      rejectUnauthorized: true,
      ca: clientCa.pem,
    });
    const output = captureOutput(t);
    const { run, kernel } = await kernelWith(t, [['secure.test', server.port]]);
    await kernel.writeFile('/k/plain.pem', mine.key);
    await kernel.writeFile('/k/locked.pem', locked);
    await kernel.writeFile('/k/stranger.pem', stranger.key);
    await kernel.writeFile('/k/pass', PASS);
    await kernel.writeFile('/k/wrong', `${PASS}-wrong`);
    const markers = [
      PASS,
      ...keyMarkers(mine.key),
      ...keyMarkers(locked),
      ...keyMarkers(stranger.key),
    ];
    const leaks = (what, text) => {
      for (const m of markers) assert.equal(text.includes(m), false, `${what} holds ${m}`);
    };
    const tls = { ca: ca.pem, servername: 'secure.test', cert: mine.cert };
    const runs = [
      await run({
        host: 'secure.test',
        port: 4433,
        tls,
        keyFile: '/k/plain.pem',
        send: 'hi',
        dump: true,
      }),
      await run({
        host: 'secure.test',
        port: 4433,
        tls,
        keyFile: '/k/locked.pem',
        passFile: '/k/pass',
        send: 'hi',
        dump: true,
      }),
      await run({
        host: 'secure.test',
        port: 4433,
        tls,
        keyFile: '/k/locked.pem',
        passFile: '/k/wrong',
      }),
      await run({ host: 'secure.test', port: 4433, tls, keyFile: '/k/locked.pem' }),
      await run({ host: 'secure.test', port: 4433, tls, keyFile: '/k/stranger.pem' }),
      await run({
        host: 'secure.test',
        port: 4433,
        tls: { ...tls, pfx: 'x' },
        keyFile: '/k/plain.pem',
      }),
      await run({
        host: 'localhost',
        port: 4433,
        tls: { cert: mine.cert },
        keyFile: '/k/plain.pem',
      }),
    ];
    assert.deepEqual(
      runs.map((r) => r.echo ?? r.code),
      [
        'kernel client hi',
        'kernel client hi',
        'ERR_OSSL_BAD_DECRYPT',
        'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED',
        'ERR_OSSL_X509_KEY_VALUES_MISMATCH',
        'ENOTSUP',
        'ENOTSUP',
      ]
    );
    for (const r of runs.slice(0, 2)) {
      assert.equal(r.tls.clientCertificate, true);
      assert.ok(r.dump.proc.includes('/proc/self/status'), 'the program read /proc');
      assert.deepEqual(
        r.dump.keys.filter((k) => /key|pass|cert/i.test(k)),
        []
      );
    }
    for (const [i, r] of runs.entries()) leaks(`run ${i}`, JSON.stringify(r));
    leaks('the host process output', output());
  }
);

const PLACEHOLDER = 'SEALED_PLACEHOLDER_1';
const SECRET = 'zzy1049-the-sealed-secret';

function substitutingTransport() {
  const seen = [];
  return {
    seen,
    traits: {
      manualRedirects: false,
      encodedBodies: false,
      maxRequestBody: 1 << 20,
      websocket: false,
    },
    async fetch(req) {
      seen.push(JSON.stringify(req).replaceAll(PLACEHOLDER, SECRET));
      return {
        status: 200,
        statusText: 'OK',
        headers: [],
        body: (async function* () {})(),
        cancel: async () => {},
      };
    },
  };
}

test(
  'a sealed placeholder written into an A2 session with checkHostname: false, sni: false, or either with a client certificate reaches the server as written, never substituted, and the session says substitutes: false (#1049)',
  TIMEOUT,
  async (t) => {
    const mine = clientCa.server('kernel client', { eku: CLIENT_AUTH });
    const received = [];
    const listen = async (cert) => {
      const server = createServer(
        {
          key: cert.key,
          cert: cert.cert,
          requestCert: true,
          rejectUnauthorized: false,
          ca: clientCa.pem,
        },
        (s) => {
          s.on('data', (d) => {
            received.push(String(d));
            s.write(d);
          });
        }
      );
      server.on('tlsClientError', () => {});
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      t.after(() => server.close());
      return server.address().port;
    };
    const wrong = await listen(ca.server('other.test'));
    const right = await listen(ca.server('secure.test'));
    const transport = substitutingTransport();
    const peers = {};
    for (const [address, port] of [
      ['203.0.113.10', wrong],
      ['203.0.113.11', right],
    ]) {
      for (const p of [443, 4433]) peers[`${address}:${p}`] = pipeTo(port);
    }
    const uplink = fakeUplink({
      routes: { prefixes: [], exit: true },
      names: { 'wrong.test': ['203.0.113.10'], 'secure.test': ['203.0.113.11'] },
      peers,
    });
    const kernel = await createNodeKernel({ users: 'off', network: { uplink, transport } });
    t.after(() => kernel.terminate());
    await install(kernel, 'wasm-tls-engine');
    await kernel.writeFile('/node_modules/tlsup/package.json', PACKAGE);
    await kernel.writeFile('/node_modules/tlsup/bin/tlsup.mjs', PROGRAM);
    const run = async (o) =>
      JSON.parse((await kernel.run(['tlsup', JSON.stringify(o)], { cwd: '/' })).stdout);
    const client = { cert: mine.cert, key: mine.key };
    const cases = [
      ['wrong.test', { checkHostname: false }],
      ['wrong.test', { checkHostname: false, ...client }],
      ['secure.test', { sni: false }],
      ['secure.test', { sni: false, ...client }],
      ['wrong.test', { checkHostname: false, sni: false, ...client }],
    ];
    for (const port of [443, 4433]) {
      for (const [host, extra] of cases) {
        const send = `GET / HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${PLACEHOLDER}\r\n`;
        const got = await run({
          host,
          port,
          tls: { ca: ca.pem, servername: 'secure.test', ...extra },
          send,
        });
        assert.equal(got.tls?.path, 'kernel', JSON.stringify([host, port, extra, got]));
        assert.equal(got.tls.substitutes, false);
        assert.equal(got.echo, send.trim());
      }
    }
    const bare = [
      ['secure.test', { sni: false, rejectUnauthorized: false }],
      ['secure.test', { ...client, rejectUnauthorized: false }],
      ['secure.test', { sni: false, ...client, rejectUnauthorized: false }],
    ];
    for (const [host, extra] of bare) {
      const send = `GET / HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${PLACEHOLDER}\r\n`;
      const got = await run({ host, port: 443, tls: extra, send });
      assert.equal(got.tls?.path, 'kernel', JSON.stringify([host, extra, got]));
      assert.equal(got.tls.substitutes, false);
      assert.equal(got.echo, send.trim());
    }
    for (const extra of [{ checkHostname: false }, { checkHostname: false, ...client }]) {
      const got = await run({
        host: 'wrong.test',
        port: 443,
        tls: extra,
        send: `Bearer ${PLACEHOLDER}`,
      });
      assert.equal(got.code, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', JSON.stringify([extra, got]));
    }
    assert.equal(received.length, 13);
    for (const r of received) {
      assert.ok(r.includes(`Bearer ${PLACEHOLDER}`), r);
      assert.equal(r.includes(SECRET), false);
    }
    assert.deepEqual(transport.seen, []);
  }
);
