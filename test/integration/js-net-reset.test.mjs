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
  out.buffered = await code(s2.readable.getReader().read());
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

test('conn.reset() closes a loopback connection with an RST: the peer pending and next reads and its writes are ECONNRESET, data in flight is dropped, and close() stays a FIN (#1530)', async (t) => {
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
    buffered: 'ECONNRESET',
    fin: 'eof',
  });
});
