import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { selfSigned } from './test-certs.mjs';

const PROGRAM = `const te = new TextEncoder();
const td = new TextDecoder();
const code = (f) => Promise.resolve().then(f).then(() => 'ok', (e) => e.code);

async function all(ctx, fd) {
  let text = '';
  for (;;) {
    const chunk = await ctx.read(fd, 65536);
    if (chunk.length === 0) return text;
    text += td.decode(chunk);
  }
}

async function child(ctx) {
  const out = {};
  ctx.sync.setcred({ ruid: 1000, euid: 1000, suid: 1000 });
  out.direct = await code(() => ctx.open('/srv/secret', { read: true }));
  const got = await ctx.recvmsg(0, 64);
  out.bytes = td.decode(got.bytes);
  out.count = got.fds.length;
  out.ctrunc = got.ctrunc;
  const [file, server] = got.fds;
  out.offset = td.decode(await ctx.read(file, 2));
  const listener = await ctx.net.adopt(server);
  const conn = await listener.accept();
  await conn.writable.getWriter().write(te.encode('hi'));
  await conn.close();
  await listener.close();
  out.next = td.decode((await ctx.recvmsg(0, 64)).bytes);
  await ctx.write(0, JSON.stringify(out));
  return 0;
}

async function refusals(ctx, o, a) {
  const out = {};
  const plain = await ctx.open('/srv/plain', { read: true });
  const send = (fds, body = 'x') => code(() => ctx.sendmsg(a, body, { fds }));
  const tls = await ctx.net.listen({ tls: { cert: o.cert, key: o.key } });
  out.tlsListener = await send([tls.fd]);
  const accepting = tls.accept();
  const secured = await ctx.net.connect({ host: 'localhost', port: tls.port, tls: { ca: o.cert } });
  out.securedConn = await send([secured.fd]);
  const accepted = await accepting;
  out.securedServer = await send([accepted.fd]);
  out.unixEnd = await send([a]);
  out.tooMany = await send(new Array(254).fill(plain.fd));
  out.empty = await send([plain.fd], '');
  out.badFd = await send([999]);
  out.inetCarrier = await code(() => ctx.sendmsg(secured.fd, 'x', { fds: [plain.fd] }));
  await secured.close();
  await accepted.close();
  await tls.close();
  await ctx.close(plain.fd);
  return out;
}

async function dropped(ctx, readFirst) {
  const [c, d] = await ctx.socketpair();
  const l = await ctx.net.listen({});
  const accepting = l.accept();
  const client = await ctx.net.connect({ port: l.port });
  const server = await accepting;
  await ctx.sendmsg(c, 'y', { fds: [server.fd] });
  await server.close();
  if (readFirst) await ctx.read(d, 64);
  else await ctx.close(d);
  const end = await client.readable.getReader().read().then((r) => (r.done ? 'eof' : 'data'));
  await client.close();
  await l.close();
  await ctx.close(c);
  if (readFirst) await ctx.close(d);
  return end;
}

export default async function main(ctx) {
  if (ctx.argv[1] === 'child') return child(ctx);
  const o = JSON.parse(ctx.argv[1]);
  const [a, b] = await ctx.socketpair();
  const file = await ctx.open('/srv/secret', { read: true });
  const first = td.decode(await ctx.read(file.fd, 2));
  const l = await ctx.net.listen({});
  const spawned = await ctx.spawn({ argv: ['fdp', 'child'], stdin: b, stdout: 'inherit', stderr: 'inherit' });
  await ctx.close(b);
  const sent = await ctx.sendmsg(a, 'x', { fds: [file.fd, l.fd] });
  const port = l.port;
  await ctx.close(file.fd);
  await l.close();
  const conn = await ctx.net.connect({ port });
  const hi = td.decode((await conn.readable.getReader().read()).value);
  await conn.close();
  const refused = await refusals(ctx, o, a);
  await ctx.sendmsg(a, 'z');
  const reply = JSON.parse(await all(ctx, a));
  await ctx.close(a);
  const out = {
    first,
    sent,
    hi,
    pid: spawned.pid > 0,
    child: reply,
    refused,
    receiverClosed: await dropped(ctx, false),
    plainRead: await dropped(ctx, true),
  };
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

test('a descriptor passes over a socketpair write as SCM_RIGHTS: the open file description (its offset, a listener the sender closed) under users enforce, the refused kinds, and rights dropped by a plain read or a closed receiver (#1562)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/fdp/package.json',
    JSON.stringify({ name: 'fdp', slicc: { commands: { fdp: { abi: 'js', module: 'p.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/fdp/p.mjs', PROGRAM);
  const base = new URL('../../node_modules/@ai-ecoverse/wasm-tls-engine/', import.meta.url);
  for (const e of await readdir(base, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = join(e.parentPath, e.name);
    const at = relative(fileURLToPath(base), f);
    await kernel.writeFile(`/node_modules/@ai-ecoverse/wasm-tls-engine/${at}`, await readFile(f));
  }
  await kernel.writeFile('/srv/secret', 'abcdef');
  await kernel.writeFile('/srv/plain', 'plain');
  await kernel.chmod('/srv/secret', 0o600);
  const own = selfSigned('localhost');
  const r = await kernel.run(['fdp', JSON.stringify({ cert: own.cert, key: own.key })], {
    cwd: '/',
  });
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), {
    first: 'ab',
    sent: 1,
    hi: 'hi',
    pid: true,
    child: {
      direct: 'EACCES',
      bytes: 'x',
      count: 2,
      ctrunc: false,
      offset: 'cd',
      next: 'z',
    },
    refused: {
      tlsListener: 'EPERM',
      securedConn: 'EPERM',
      securedServer: 'EPERM',
      unixEnd: 'EOPNOTSUPP',
      tooMany: 'EINVAL',
      empty: 'EINVAL',
      badFd: 'EBADF',
      inetCarrier: 'EOPNOTSUPP',
    },
    receiverClosed: 'eof',
    plainRead: 'eof',
  });
});
