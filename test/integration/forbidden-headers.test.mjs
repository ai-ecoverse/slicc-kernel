import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createNodeKernel, nodeTransport } from '../../dist/node.js';

const DUMMY_COOKIE = 'session=dummy-not-a-credential';
const REFERER = 'https://referer.test/page';

const PACKAGE = JSON.stringify({
  name: 'headerfetch',
  slicc: { commands: { headerfetch: { abi: 'js', module: 'bin/headerfetch.mjs' } } },
});

const PROGRAM = `export default async function main(ctx) {
  const r = await ctx.fetch(ctx.argv[1], { headers: JSON.parse(ctx.argv[2]) });
  await ctx.write(1, (await r.text()) + '\\n');
}
`;

test('ctx.fetch through nodeTransport delivers Cookie and Referer with ordinary headers (#1796)', {
  timeout: 30000,
}, async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const kernel = await createNodeKernel({
    users: 'off',
    network: { transport: nodeTransport({ hostLoopback: true }) },
  });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/headerfetch/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/headerfetch/bin/headerfetch.mjs', PROGRAM);
  const headers = { 'X-Probe': 'visible', Cookie: DUMMY_COOKIE, Referer: REFERER };
  const url = `http://host.slicc.internal:${server.address().port}/echo`;
  const { stdout, stderr, status } = await kernel.run(
    ['headerfetch', url, JSON.stringify(headers)],
    { cwd: '/' }
  );
  assert.equal(stderr, '');
  assert.equal(status, 0);
  const seen = JSON.parse(stdout);
  assert.equal(seen['x-probe'], 'visible');
  assert.equal(seen.cookie, DUMMY_COOKIE);
  assert.equal(seen.referer, REFERER);
});
