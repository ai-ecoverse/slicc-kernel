import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { connect as tcp } from 'node:net';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { fakeUplink } from '../../dist/testing.js';
import { PG_CLIENT } from './pg-client-program.mjs';
import { pgFixture } from './pg-fixture.mjs';
import { makeCa } from './test-certs.mjs';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 120_000 };
const ca = makeCa();
const PH = 'fnox_proxy_0123456789abcdef01234567';
const VALUE = 'TEST-ONLY-SEALED-VALUE-1';

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

async function kernelWith(t, servers, answer) {
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
    exit: 'tailscale',
  });
  const asked = [];
  const sealed = async (req) => {
    if (req.op !== 'sessionMaterialize') return { v: 1, error: { code: 'EINVAL' } };
    asked.push(req);
    return answer(req);
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
  const kernel = await createNodeKernel({
    users: 'off',
    ...(answer ? { sealed } : {}),
    network: { uplink, transport },
  });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-tls-engine');
  await kernel.writeFile('/node_modules/@ai-ecoverse/wasm-tls-engine/dist/roots.der', ca.der);
  await kernel.writeFile(
    '/node_modules/pgc/package.json',
    JSON.stringify({ name: 'pgc', slicc: { commands: { pgc: { abi: 'js', module: 'pgc.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/pgc/pgc.mjs', PG_CLIENT);
  const run = async (o) => {
    const r = await kernel.run(['pgc', JSON.stringify(o)], { cwd: '/' });
    assert.equal(r.stderr, '');
    return JSON.parse(r.stdout);
  };
  return { run, asked };
}

const matched = (req) =>
  req.position === 'scram-sha-256'
    ? { values: { [PH]: VALUE } }
    : { v: 1, error: { code: 'EACCES' } };

test(
  'pg SCRAM-SHA-256 with a sealed password: the server accepts the proof the kernel computed from the value, and the program checks the signature it expects (#1090)',
  TIMEOUT,
  async (t) => {
    const db = await pgFixture(t, ca.server('db.test'), VALUE);
    const { run, asked } = await kernelWith(t, [['db.test', db.port]], matched);
    const got = await run({ host: 'db.test', port: 5432, password: PH });
    assert.deepEqual(got.tls, { verified: true, substitutes: true });
    assert.deepEqual(got.mechanisms, ['SCRAM-SHA-256']);
    assert.equal(got.steps.includes('final ok'), true, JSON.stringify(got));
    assert.equal(got.steps.includes('R 0'), true, JSON.stringify(got));
    assert.equal(db.seen.authenticated, 1);
    assert.equal(asked.length, 1);
    const { scram, placeholders, position, protocol } = asked[0];
    assert.deepEqual([protocol, position, placeholders], ['pg', 'scram-sha-256', undefined]);
    assert.equal(scram.clientFirstBare, 'n=,r=fixedtestclientnonce');
    assert.match(scram.clientFinalBare, /^c=biws,r=fixedtestclientnonce/);
    assert.equal(JSON.stringify(got).includes(VALUE), false);
  }
);

test(
  "pg SCRAM-SHA-256: with no matching session rule the program's own proof goes out and the server refuses it; a server whose final signature does not verify ends the session (#1090)",
  TIMEOUT,
  async (t) => {
    const db = await pgFixture(t, ca.server('db.test'), VALUE);
    const unbound = await kernelWith(t, [['db.test', db.port]], () => ({
      v: 1,
      error: { code: 'EACCES' },
    }));
    const refused = await unbound.run({ host: 'db.test', port: 5432, password: PH });
    assert.equal(refused.steps.at(-1).startsWith('E '), true, JSON.stringify(refused));
    assert.equal(db.seen.authenticated, 0);
    assert.equal(unbound.asked.length, 1);
    const other = await pgFixture(t, ca.server('db.test'), VALUE, {
      signWith: 'TEST-ONLY-OTHER-VALUE-2',
    });
    const wrong = await kernelWith(t, [['db.test', other.port]], matched);
    const failed = await wrong.run({ host: 'db.test', port: 5432, password: PH });
    assert.equal(failed.steps.includes('final ok'), false, JSON.stringify(failed));
    assert.equal(failed.steps.includes('final mismatch'), false, JSON.stringify(failed));
    assert.equal(failed.steps.at(-1), 'error ERR_SSL_PROTOCOL_ERROR', JSON.stringify(failed));
  }
);

test(
  'pg SCRAM-SHA-256: an ErrorResponse instead of the final message, which would carry the substituted proof back, ends the session before the program reads it (#1090, #1138 review)',
  TIMEOUT,
  async (t) => {
    const db = await pgFixture(t, ca.server('db.test'), VALUE, { echoFinal: true });
    const { run } = await kernelWith(t, [['db.test', db.port]], matched);
    const got = await run({ host: 'db.test', port: 5432, password: PH });
    assert.equal(got.steps.at(-1), 'error ERR_SSL_PROTOCOL_ERROR', JSON.stringify(got));
    assert.equal(JSON.stringify(got).includes('received c=biws'), false, JSON.stringify(got));
    assert.equal(JSON.stringify(got).includes(VALUE), false);
  }
);

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const header = (db) =>
  db.seen.plus.finals.map((f) =>
    Buffer.from(f.slice(2, f.indexOf(',')), 'base64')
      .toString('latin1')
      .slice(0, 3)
  );

test(
  'the SCRAM-PLUS fixture refuses as PostgreSQL does: y,, after it offered PLUS, and a c= whose binding is not its leaf, so the binding rows mean something (jsh#531)',
  TIMEOUT,
  async (t) => {
    const leaf = ca.server('db.test');
    const db = await pgFixture(t, leaf, 'TEST-ONLY-OWN-PASSWORD-1', { plus: true });
    const raw = await kernelWith(t, [['db.test', db.port]]);
    const y = await raw.run({
      host: 'db.test',
      port: 5432,
      password: 'TEST-ONLY-OWN-PASSWORD-1',
      gs2: 'y',
    });
    assert.deepEqual(y.tls, { verified: true, substitutes: false });
    assert.deepEqual(y.mechanisms, ['SCRAM-SHA-256-PLUS', 'SCRAM-SHA-256']);
    assert.match(y.steps.at(-1), /SCRAM channel binding negotiation error/);
    const wrong = await raw.run({
      host: 'db.test',
      port: 5432,
      password: 'TEST-ONLY-OWN-PASSWORD-1',
      gs2: 'p',
      binding: b64(Buffer.alloc(32, 7)),
    });
    assert.match(wrong.steps.at(-1), /SCRAM channel binding check failed/);
    const right = await raw.run({
      host: 'db.test',
      port: 5432,
      password: 'TEST-ONLY-OWN-PASSWORD-1',
      gs2: 'p',
      binding: b64(db.binding),
    });
    assert.equal(right.steps.includes('final ok'), true, JSON.stringify(right));
    assert.deepEqual(db.seen.plus.refused, [
      'SCRAM channel binding negotiation error',
      'SCRAM channel binding check failed',
    ]);
    assert.equal(db.seen.authenticated, 1);
  }
);

test(
  'pg SCRAM-SHA-256-PLUS with a sealed password: y,, (libpq prefer), p= with the right binding (pg enableChannelBinding), p= with a wrong one, and n,, all authenticate, the kernel binding to the verified leaf where the server would refuse what the program sent (jsh#531)',
  TIMEOUT,
  async (t) => {
    const db = await pgFixture(t, ca.server('db.test'), VALUE, { plus: true });
    const { run } = await kernelWith(t, [['db.test', db.port]], matched);
    const results = [];
    for (const o of [
      { gs2: 'y' },
      { gs2: 'p', binding: b64(db.binding) },
      { gs2: 'p', binding: b64(Buffer.alloc(32, 7)) },
      { gs2: 'n' },
    ]) {
      const got = await run({ host: 'db.test', port: 5432, password: PH, ...o });
      assert.deepEqual(got.mechanisms, ['SCRAM-SHA-256-PLUS', 'SCRAM-SHA-256']);
      results.push(got.steps.includes('final ok') && got.steps.includes('R 0'));
      assert.equal(JSON.stringify(got).includes(VALUE), false);
    }
    assert.deepEqual(results, [true, true, true, true], JSON.stringify(db.seen.plus));
    assert.deepEqual(db.seen.plus.refused, []);
    assert.deepEqual(header(db), ['p=t', 'p=t', 'p=t', 'n,,']);
    assert.equal(db.seen.authenticated, 4);
  }
);

test(
  'pg SCRAM-SHA-256 in a substituting session: a program using its own password with n,, still authenticates against a PLUS server, and y,, against a server without PLUS goes through unchanged (jsh#531)',
  TIMEOUT,
  async (t) => {
    const own = 'TEST-ONLY-OWN-PASSWORD-1';
    const plus = await pgFixture(t, ca.server('db.test'), own, { plus: true });
    const a = await kernelWith(t, [['db.test', plus.port]], () => ({
      v: 1,
      error: { code: 'EACCES' },
    }));
    const mine = await a.run({ host: 'db.test', port: 5432, password: own, gs2: 'n' });
    assert.equal(mine.steps.includes('final ok'), true, JSON.stringify(mine));
    assert.deepEqual(mine.tls, { verified: true, substitutes: true });
    const plain = await pgFixture(t, ca.server('db.test'), VALUE);
    const b = await kernelWith(t, [['db.test', plain.port]], matched);
    const y = await b.run({ host: 'db.test', port: 5432, password: PH, gs2: 'y' });
    assert.deepEqual(y.mechanisms, ['SCRAM-SHA-256']);
    assert.equal(y.steps.includes('final ok'), true, JSON.stringify(y));
    const final = plain.seen.messages
      .map((m) => m.subarray(5).toString('latin1'))
      .find((m) => m.startsWith('c='));
    assert.equal(final.slice(0, 7), 'c=eSws,');
  }
);
