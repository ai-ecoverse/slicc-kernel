import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  if (o.derCa) o.tls.ca = [Uint8Array.from(atob(o.derCa), (ch) => ch.charCodeAt(0))];
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
    if (peerCertificates?.length) out.leafSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', peerCertificates[0]))).map((b) => b.toString(16).padStart(2, '0')).join('');
    await say(out);
    await c.close();
  } catch (e) {
    await say({ code: e.code, detail: e.detail });
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
  servers.forEach(([host, port], i) => {
    const address = /^\d/.test(host) ? host : `203.0.113.${10 + i}`;
    if (address !== host) names[host] = [address];
    for (const p of [4433, 465, 443, 2525]) peers[`${address}:${p}`] = pipeTo(port);
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
  return { run, uplink, transport: tr };
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
