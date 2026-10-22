import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PACKAGE = JSON.stringify({
  name: 'synclisten',
  slicc: { commands: { synclisten: { abi: 'js', module: 'bin/synclisten.mjs' } } },
});

const PROGRAM = `export default async function main(ctx) {
  const out = [];
  const l = ctx.sync.net.listen({ port: 0 });
  out.push('listening ' + typeof l.port + ' ' + (l.port > 0) + ' ' + l.host);
  for (const options of [{ port: l.port }, { port: 53 }, { host: '::1', port: 0 }]) {
    try {
      ctx.sync.net.listen(options).close();
      out.push('bound');
    } catch (e) {
      out.push(e.code);
    }
  }
  const accepted = l.accept();
  const c = await ctx.net.connect({ port: l.port });
  const s = await accepted;
  const w = c.writable.getWriter();
  await w.write(new TextEncoder().encode('ping'));
  await w.close();
  const r = s.readable.getReader();
  const { value } = await r.read();
  out.push('got ' + new TextDecoder().decode(value));
  await s.close();
  await c.close();
  await l.close();
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

test('ctx.sync.net.listen binds before it returns, so the port is known at once, with the async listener and the same bind checks as ctx.net.listen (#1398, slicc-jsh#743)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/synclisten/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/synclisten/bin/synclisten.mjs', PROGRAM);
  const r = await kernel.run(['synclisten'], { cwd: '/' });
  assert.equal(
    r.stdout,
    'listening number true 127.0.0.1\nEADDRINUSE\nEADDRINUSE\nEADDRNOTAVAIL\ngot ping\n',
    r.stderr
  );
});
