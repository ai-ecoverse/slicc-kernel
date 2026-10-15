import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createNodeKernel, nodeTransport } from '../../dist/node.js';

const PROBE_PACKAGE = JSON.stringify({
  name: 'fidelity',
  slicc: { commands: { fidelity: { abi: 'js', module: 'bin/fidelity.mjs' } } },
});

const PROBE = `const why = (err) => (err.cause?.code ?? err.code ?? '') + ' ' + (err.cause?.message ?? err.message);
async function serve(ctx, port, ...answer) {
  const listener = await ctx.net.listen({ port });
  const done = listener.accept().then(async (c) => {
    const w = c.writable.getWriter();
    for (const part of answer) await w.write(typeof part === 'string' ? new TextEncoder().encode(part) : part);
    await w.close();
    await c.close();
    await listener.close();
  });
  return { done };
}
export default async function main(ctx) {
  const [mode, base] = ctx.argv.slice(1);
  const say = (line) => ctx.write(1, line + '\\n');
  if (mode === 'gzip') {
    const body = Uint8Array.from(atob(base), (ch) => ch.charCodeAt(0));
    const { done } = await serve(ctx, 7003, 'HTTP/1.1 200 OK\\r\\nContent-Encoding: gzip\\r\\nContent-Length: ' + body.length + '\\r\\n\\r\\n', body);
    const r = await ctx.fetch('http://127.0.0.1:7003/');
    await say(r.headers.get('content-encoding') + ' ' + r.headers.get('content-length') + ' ' + (await r.text()));
    await done;
  } else if (mode === 'cut') {
    const r = await ctx.fetch(base + '/cut');
    await say(await r.text().then((t) => 'read ' + t, (err) => err.name + ' ' + err.message));
  } else if (mode === 'bad-port') {
    await say(await ctx.fetch(base).then((r) => String(r.status), why));
  } else if (mode === 'redirect-error') {
    await say(await ctx.fetch(base + '/go', { redirect: 'error' }).then((r) => String(r.status), why));
  } else if (mode === 'local-bad-port') {
    const { done } = await serve(ctx, 6000, 'HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\n\\r\\nlocal');
    await say(await ctx.fetch('http://127.0.0.1:6000/').then(async (r) => r.status + ' ' + (await r.text()), why));
    await done;
  } else if (mode === 'upgrade') {
    const { done } = await serve(ctx, 7002, 'HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\n\\r\\n');
    await say(await ctx.websocket('ws://127.0.0.1:7002/').then(() => 'open', why));
    await done;
  }
}
`;

async function hostServer(t) {
  const server = createServer((req, res) => {
    if (req.url === '/cut') {
      res.writeHead(200, { 'content-length': 100 });
      res.write('only part');
      setTimeout(() => res.socket.destroy(), 50);
    } else if (req.url === '/go') {
      res.writeHead(302, { location: '/other' });
      res.end();
    } else if (req.url === '/to-bad') {
      res.writeHead(302, { location: 'http://host.slicc.internal:6000/' });
      res.end();
    } else {
      res.end('other');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://host.slicc.internal:${server.address().port}`;
}

async function kernelWith(t) {
  const kernel = await createNodeKernel({
    users: 'off',
    network: { transport: nodeTransport({ hostLoopback: true }) },
  });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/fidelity/package.json', PROBE_PACKAGE);
  await kernel.writeFile('/node_modules/fidelity/bin/fidelity.mjs', PROBE);
  return async (...args) => (await kernel.run(['fidelity', ...args], { cwd: '/' })).stdout;
}

test('ctx.fetch keeps content-encoding on a decoded body and cuts a short body with "terminated"', {
  timeout: 30000,
}, async (t) => {
  const base = await hostServer(t);
  const run = await kernelWith(t);
  assert.equal(await run('gzip', gzipSync('unzipped').toString('base64')), 'gzip null unzipped\n');
  assert.equal(await run('cut', base), 'TypeError terminated\n');
});

test('ctx.fetch refuses a bad port outside the kernel, a redirect to one, and says "unexpected redirect"', {
  timeout: 30000,
}, async (t) => {
  const base = await hostServer(t);
  const run = await kernelWith(t);
  assert.equal(
    await run('bad-port', 'http://host.slicc.internal:6000/'),
    'EACCES bad port: http://host.slicc.internal:6000/: EACCES\n'
  );
  assert.equal(
    await run('bad-port', `${base}/to-bad`),
    'EACCES bad port: http://host.slicc.internal:6000/: EACCES\n'
  );
  assert.equal(await run('redirect-error', base), 'EREDIRECT unexpected redirect: EREDIRECT\n');
});

test("a bad port on the kernel's own loopback is reachable, and a refused upgrade names the status", {
  timeout: 30000,
}, async (t) => {
  const run = await kernelWith(t);
  assert.equal(await run('local-bad-port'), '200 local\n');
  assert.equal(
    await run('upgrade'),
    'EPROTO net-ws-ready: EPROTO: the server answered the upgrade with 404 Not Found: EPROTO\n'
  );
});
