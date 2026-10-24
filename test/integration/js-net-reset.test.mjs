import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = `export default async function main(ctx) {
  const out = {};
  const code = (p) => p.then(() => 'ok', (e) => e.code);
  const l = await ctx.net.listen({});
  const acc = l.accept();
  const client = await ctx.net.connect({ port: l.port });
  const server = await acc;
  const reader = server.readable.getReader();
  const pending = reader.read().then((r) => (r.done ? 'eof' : 'data'), (e) => e.code);
  await client.reset();
  out.pending = await pending;
  out.again = await code(reader.read());
  const w = server.writable.getWriter();
  out.write = await code(w.write(new Uint8Array(1)));
  await server.close();
  const acc2 = l.accept();
  const c2 = await ctx.net.connect({ port: l.port });
  const s2 = await acc2;
  const w2 = c2.writable.getWriter();
  await w2.write(new TextEncoder().encode('lost'));
  await c2.reset();
  const r2 = s2.readable.getReader();
  out.buffered = await r2.read().then((r) => new TextDecoder().decode(r.value), (e) => e.code);
  out.afterBuffered = await code(r2.read());
  await s2.close();
  const acc3 = l.accept();
  const c3 = await ctx.net.connect({ port: l.port });
  const s3 = await acc3;
  await c3.close();
  out.fin = await s3.readable.getReader().read().then((r) => (r.done ? 'eof' : 'data'), (e) => e.code);
  await s3.close();
  await c3.reset();
  await l.close();
  ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

test('conn.reset() closes a loopback connection with an RST: the peer pending and next reads and its writes are ECONNRESET, the peer reads what it already received and then gets ECONNRESET (#1577), and close() stays a FIN (#1530)', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/rst/package.json',
    JSON.stringify({ name: 'rst', slicc: { commands: { rst: { abi: 'js', module: 'r.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/rst/r.mjs', PROGRAM);
  const r = await kernel.run(['rst'], { cwd: '/' });
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), {
    pending: 'ECONNRESET',
    again: 'ECONNRESET',
    write: 'ECONNRESET',
    buffered: 'lost',
    afterBuffered: 'ECONNRESET',
    fin: 'eof',
  });
});

const TLS_PROGRAM = `export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  const out = {};
  const l = await ctx.net.listen({ tls: { cert: o.cert, key: o.key } });
  const acc = l.accept();
  const client = await ctx.net.connect({ host: 'localhost', port: l.port, tls: { ca: o.cert } });
  const server = await acc;
  const pending = server.readable.getReader().read().then((r) => (r.done ? 'eof' : 'data'), (e) => e.code);
  await client.reset();
  out.tls = await pending;
  await server.close();
  await l.close();
  const plain = await ctx.net.listen({});
  const acc2 = plain.accept();
  const raw = await ctx.net.connect({ port: plain.port });
  const s2 = await acc2;
  const serving = ctx.net.secure(s2, { server: true, cert: o.cert, key: o.key });
  const c2 = await ctx.net.secure(raw, { ca: o.cert, servername: 'localhost' });
  const served = await serving;
  const waiting = c2.readable.getReader().read().then((r) => (r.done ? 'eof' : 'data'), (e) => e.code);
  await served.reset();
  out.secured = await waiting;
  await c2.close();
  await plain.close();
  ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

test('reset() works on TLS connections too: a loopback TLS client that resets gives the server pending read ECONNRESET, and a secure()d server that resets gives its client one (#1530)', async (t) => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join, relative } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { selfSigned } = await import('./test-certs.mjs');
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  const base = new URL('../../node_modules/@ai-ecoverse/wasm-tls-engine/', import.meta.url);
  for (const e of (await readdir(base, { recursive: true, withFileTypes: true })).filter((x) =>
    x.isFile()
  )) {
    const f = join(e.parentPath, e.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/wasm-tls-engine/${relative(fileURLToPath(base), f)}`,
      await readFile(f)
    );
  }
  await kernel.writeFile(
    '/node_modules/rsttls/package.json',
    JSON.stringify({
      name: 'rsttls',
      slicc: { commands: { rsttls: { abi: 'js', module: 'r.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/rsttls/r.mjs', TLS_PROGRAM);
  const own = selfSigned('localhost');
  const r = await kernel.run(['rsttls', JSON.stringify({ cert: own.cert, key: own.key })], {
    cwd: '/',
  });
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), { tls: 'ECONNRESET', secured: 'ECONNRESET' });
});

const SERVE_PROGRAM = `export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  const out = {};
  const l = await ctx.net.listen({});
  for (const how of ['reset', 'close']) {
    const acc = l.accept();
    const raw = await ctx.net.connect({ port: l.port });
    const s = await acc;
    const serving = ctx.net.secure(s, { server: true, cert: o.cert, key: o.key }).then(
      () => 'ok',
      (e) => ({ code: e.code, message: String(e.message) })
    );
    await raw[how]();
    out[how] = await serving;
    await s.close();
  }
  const acc = l.accept();
  const raw = await ctx.net.connect({ port: l.port });
  const s = await acc;
  await s.reset();
  out.early = await ctx.net.secure(raw, { ca: o.cert, servername: 'localhost' }).then(
    () => 'ok',
    (e) => ({ code: e.code, message: String(e.message) })
  );
  await raw.close();
  await l.close();
  ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

test('a server handshake tells a client that resets (read ECONNRESET) from one that closes, as Node 22 does (#1578), and a client whose server reset before the ClientHello gets read ECONNRESET too, not EPIPE (#1611)', async (t) => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join, relative } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { selfSigned } = await import('./test-certs.mjs');
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  const base = new URL('../../node_modules/@ai-ecoverse/wasm-tls-engine/', import.meta.url);
  for (const e of await readdir(base, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = join(e.parentPath, e.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/wasm-tls-engine/${relative(fileURLToPath(base), f)}`,
      await readFile(f)
    );
  }
  await kernel.writeFile(
    '/node_modules/srvrst/package.json',
    JSON.stringify({
      name: 'srvrst',
      slicc: { commands: { srvrst: { abi: 'js', module: 's.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/srvrst/s.mjs', SERVE_PROGRAM);
  const own = selfSigned('localhost');
  const r = await kernel.run(['srvrst', JSON.stringify({ cert: own.cert, key: own.key })], {
    cwd: '/',
  });
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.reset.code, 'ECONNRESET', r.stdout);
  assert.match(out.reset.message, /read ECONNRESET/);
  assert.equal(out.close.code, 'ECONNRESET', r.stdout);
  assert.match(out.close.message, /the client closed the connection during the TLS handshake/);
  assert.doesNotMatch(out.close.message, /read ECONNRESET/);
  assert.equal(out.early.code, 'ECONNRESET', r.stdout);
  assert.match(out.early.message, /read ECONNRESET/);
});
