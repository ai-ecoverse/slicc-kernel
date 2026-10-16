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
const cause = (err) => err.name + ' ' + err.message + ' / ' + JSON.stringify({ name: err.cause?.name, message: err.cause?.message, code: err.cause?.code });
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
    await say(await r.text().then((t) => 'read ' + t, cause));
  } else if (mode === 'local-cut') {
    const { done } = await serve(ctx, 7006, 'HTTP/1.1 200 OK\\r\\nContent-Length: 100\\r\\n\\r\\npart');
    const r = await ctx.fetch('http://127.0.0.1:7006/');
    await say(await r.text().then((t) => 'read ' + t, cause));
    await done;
  } else if (mode === 'headers') {
    const listener = await ctx.net.listen({ port: 7007 });
    const done = listener.accept().then(async (c) => {
      const reader = c.readable.getReader();
      let head = '';
      while (!head.includes('\\r\\n\\r\\n')) head += new TextDecoder().decode((await reader.read()).value);
      const lines = head.split('\\r\\n').filter(Boolean).slice(1);
      const body = new TextEncoder().encode(JSON.stringify(lines));
      const w = c.writable.getWriter();
      await w.write(new TextEncoder().encode('HTTP/1.1 200 OK\\r\\nContent-Length: ' + body.length + '\\r\\n\\r\\n'));
      await w.write(body);
      await w.close();
      await c.close();
      await listener.close();
    });
    const r = await ctx.fetch('http://127.0.0.1:7007/h', { headers: { 'x-b': '1', 'x-a': '2' } });
    await say(await r.text());
    await done;
  } else if (mode === 'bad-port') {
    await say(await ctx.fetch(base).then((r) => String(r.status), (err) => err.name + ' ' + err.message + ' / ' + why(err)));
  } else if (mode === 'redirect-error') {
    await say(await ctx.fetch(base + '/go', { redirect: 'error' }).then((r) => String(r.status), why));
  } else if (mode === 'local-bad-port') {
    await say(await ctx.fetch('http://127.0.0.1:1/').then((r) => String(r.status), (err) => err.name + ' ' + err.message + ' / ' + why(err)));
    const { done } = await serve(ctx, 7005, 'HTTP/1.1 302 Found\\r\\nLocation: http://127.0.0.1:25/\\r\\nContent-Length: 0\\r\\n\\r\\n');
    await say(await ctx.fetch('http://127.0.0.1:7005/').then((r) => String(r.status), (err) => err.name + ' ' + err.message + ' / ' + why(err)));
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
  const socketError =
    '{"name":"SocketError","message":"other side closed","code":"UND_ERR_SOCKET"}';
  assert.equal(await run('cut', base), `TypeError terminated / ${socketError}\n`);
  assert.equal(await run('local-cut'), `TypeError terminated / ${socketError}\n`);
});

test('ctx.fetch refuses a bad port outside the kernel, a redirect to one, and says "unexpected redirect"', {
  timeout: 30000,
}, async (t) => {
  const base = await hostServer(t);
  const run = await kernelWith(t);
  assert.equal(
    await run('bad-port', 'http://host.slicc.internal:6000/'),
    'TypeError fetch failed /  bad port\n'
  );
  assert.equal(await run('bad-port', `${base}/to-bad`), 'TypeError fetch failed /  bad port\n');
  assert.equal(await run('redirect-error', base), ' unexpected redirect\n');
});

test("a bad port on the kernel's own loopback is refused as undici does, and a refused upgrade names the status", {
  timeout: 30000,
}, async (t) => {
  const run = await kernelWith(t);
  assert.equal(
    await run('local-bad-port'),
    'TypeError fetch failed /  bad port\nTypeError fetch failed /  bad port\n'
  );
  assert.equal(await run('upgrade'), 'EPROTO the server answered the upgrade with 404 Not Found\n');
});

test('ctx.fetch to the kernel loopback sends the headers in the order given, after a lowercase host', {
  timeout: 30000,
}, async (t) => {
  const run = await kernelWith(t);
  assert.equal(
    await run('headers'),
    `${JSON.stringify(['host: 127.0.0.1:7007', 'connection: close', 'x-b: 1', 'x-a: 2'])}\n`
  );
});
