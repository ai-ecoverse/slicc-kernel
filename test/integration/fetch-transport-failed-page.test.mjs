import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
let server;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/open') res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('cross-origin body\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await chrome.close();
});

const PROGRAM = `export default async function main(ctx) {
  const line = await ctx.fetch(ctx.argv[1]).then(
    async (r) => 'status ' + r.status + ' ' + (await r.text()),
    (err) => JSON.stringify({
      name: err.name,
      message: err.message,
      cause: {
        name: err.cause?.name,
        code: err.cause?.code,
        message: err.cause?.message,
        detail: err.cause?.detail ?? null,
      },
    }) + '\\n'
  );
  await ctx.write(1, line);
}
`;

const failed = (detail) =>
  `${JSON.stringify({
    name: 'TypeError',
    message: 'fetch failed',
    cause: { name: 'JsCallError', code: 'ECONNREFUSED', message: 'net-head: ECONNREFUSED', detail },
  })}\n`;

async function withProgram(t) {
  const { page, run, bash } = await booted(chrome, t);
  await page.evaluate(async (program) => {
    const pkg = {
      name: 'fetchfail',
      slicc: { commands: { fetchfail: { abi: 'js', module: 'main.mjs' } } },
    };
    await window.opfs.write('node_modules/fetchfail/package.json', JSON.stringify(pkg));
    await window.opfs.write('node_modules/fetchfail/main.mjs', program);
  }, PROGRAM);
  const fetchOf = async (url) => {
    const { status, stdout, stderr } = await run(['fetchfail', url], { cwd: '/' });
    assert.equal(stderr, '');
    assert.equal(status, 0);
    return stdout;
  };
  return { fetchOf, bash };
}

test("a page-transport fetch that CORS blocks has cause.detail 'transport', with code and message unchanged (#1714)", async (t) => {
  const { fetchOf } = await withProgram(t);
  const base = `http://host.slicc.internal:${server.address().port}`;
  assert.equal(await fetchOf(`${base}/open`), 'status 200 cross-origin body\n');
  assert.equal(await fetchOf(`${base}/blocked`), failed('transport'));
});

test('a refused connection on the kernel loopback has no cause.detail in the page (#1714)', async (t) => {
  const { fetchOf } = await withProgram(t);
  assert.equal(await fetchOf('http://127.0.0.1:7014/'), failed(null));
});

test("curl through the proxy still gets the page transport's 502 for a fetch that CORS blocks (#1714)", async (t) => {
  const { bash } = await withProgram(t);
  const base = `http://host.slicc.internal:${server.address().port}`;
  const { stdout } = await bash(`curl -sS -w " %{http_code}" ${base}/blocked`, { cwd: '/' });
  assert.match(
    stdout,
    /fetch http:\/\/127\.0\.0\.1:\d+\/blocked failed \(unreachable, or not allowed by CORS\)/
  );
  assert.match(stdout, / 502$/);
});
