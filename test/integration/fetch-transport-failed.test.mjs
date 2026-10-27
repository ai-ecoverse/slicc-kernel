import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createNodeKernel, fetchTransport, nodeTransport } from '../../dist/node.js';

const PACKAGE = JSON.stringify({
  name: 'fetchfail',
  slicc: { commands: { fetchfail: { abi: 'js', module: 'bin/fetchfail.mjs' } } },
});

const PROGRAM = `export default async function main(ctx) {
  const line = await ctx.fetch(ctx.argv[1]).then(
    (r) => 'status ' + r.status,
    (err) => JSON.stringify({
      name: err.name,
      message: err.message,
      cause: {
        name: err.cause?.name,
        code: err.cause?.code,
        message: err.cause?.message,
        detail: err.cause?.detail ?? null,
      },
    })
  );
  await ctx.write(1, line + '\\n');
}
`;

const failed = (detail) =>
  `${JSON.stringify({
    name: 'TypeError',
    message: 'fetch failed',
    cause: { name: 'JsCallError', code: 'ECONNREFUSED', message: 'net-head: ECONNREFUSED', detail },
  })}\n`;

async function kernelWith(t, transport) {
  const kernel = await createNodeKernel({ users: 'off', network: { transport } });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/fetchfail/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/fetchfail/bin/fetchfail.mjs', PROGRAM);
  return async (url) => {
    const { stdout, stderr, status } = await kernel.run(['fetchfail', url], { cwd: '/' });
    assert.equal(stderr, '');
    assert.equal(status, 0);
    return stdout;
  };
}

async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a fetch the transport's own fetch rejects, as a page's does, has cause.detail 'transport' and keeps ECONNREFUSED (#1714)", {
  timeout: 30000,
}, async (t) => {
  const seen = [];
  const pageLike = fetchTransport({
    fetch: async (url) => {
      seen.push(String(url));
      throw new TypeError('Failed to fetch');
    },
  });
  const run = await kernelWith(t, pageLike);
  assert.equal(await run('https://blocked.example/data'), failed('transport'));
  assert.deepEqual(seen, ['https://blocked.example/data']);
});

test('a refused connection has no cause.detail: on the host through nodeTransport and on the kernel loopback (#1714)', {
  timeout: 30000,
}, async (t) => {
  const port = await closedPort();
  const run = await kernelWith(t, nodeTransport({ hostLoopback: true }));
  assert.equal(await run(`http://host.slicc.internal:${port}/`), failed(null));
  assert.equal(await run('http://127.0.0.1:7014/'), failed(null));
});
