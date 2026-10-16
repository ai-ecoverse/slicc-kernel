import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PACKAGE = JSON.stringify({
  name: 'abortgc',
  slicc: { commands: { abortgc: { abi: 'js', module: 'bin/abortgc.mjs' } } },
});

const PROGRAM = `const enc = new TextEncoder();
function collect() {
  let junk = [];
  for (let i = 0; i < 300; i++) junk.push(new Array(100000).fill(i));
  junk = null;
  for (let i = 0; i < 300; i++) new Array(100000).fill(i);
}
export default async function main(ctx) {
  const listener = await ctx.net.listen({ port: 0, host: '127.0.0.1' });
  const timers = [];
  (async () => {
    for await (const conn of listener) {
      const w = conn.writable.getWriter();
      await w.write(enc.encode('HTTP/1.1 200 OK\\r\\ncontent-type: text/event-stream\\r\\ntransfer-encoding: chunked\\r\\n\\r\\n'));
      let n = 0;
      const t = setInterval(() => w.write(enc.encode('9\\r\\ndata: ' + (++n % 10) + '\\n\\n\\r\\n')).catch(() => clearInterval(t)), 20);
      timers.push(t);
    }
  })();
  const out = [];
  for (const mode of ctx.argv.slice(1)) {
    const ac = new AbortController();
    const res = await ctx.fetch('http://127.0.0.1:' + listener.port + '/', { signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read();
    if (mode === 'gc') collect();
    ac.abort();
    out.push(mode + ' ' + (await reader.read().then((v) => 'resolved done=' + v.done, (e) => 'rejected ' + e.name)));
  }
  for (const t of timers) clearInterval(t);
  await listener.close();
  await ctx.write(1, out.join('\\n') + '\\n');
  return 0;
}
`;

test("ctx.fetch's body rejects with AbortError after the abort even once a GC has run, as undici's does (#888)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/abortgc/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/abortgc/bin/abortgc.mjs', PROGRAM);
  const got = await kernel.run(['abortgc', 'plain', 'gc', 'gc', 'gc'], { cwd: '/' });
  assert.equal(got.stderr, '');
  assert.equal(
    got.stdout,
    'plain rejected AbortError\ngc rejected AbortError\ngc rejected AbortError\ngc rejected AbortError\n'
  );
});
