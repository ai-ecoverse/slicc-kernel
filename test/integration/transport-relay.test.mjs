import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

const routes = {
  '/hello': () => ({
    status: 200,
    statusText: 'OK',
    headers: [
      ['content-type', 'text/plain'],
      ['set-cookie', 'a=1; Path=/'],
      ['set-cookie', 'b=2; Path=/'],
    ],
    body: 'hello through the transport\n',
  }),
  '/moved': () => ({
    status: 302,
    statusText: 'Found',
    headers: [
      ['location', '/hello'],
      ['content-length', '0'],
    ],
    body: '',
  }),
  '/echo': (body) => ({
    status: 201,
    statusText: 'Created',
    headers: [['content-type', 'text/plain']],
    body: `echo ${body}`,
  }),
};

function ownTransport() {
  const seen = [];
  return {
    seen,
    traits: { manualRedirects: true, encodedBodies: false, maxRequestBody: 1 << 20 },
    async fetch(request) {
      const body = request.body ? new TextDecoder().decode(request.body) : '';
      seen.push({ url: request.url, method: request.method, headers: request.headers, body });
      const route = routes[new URL(request.url).pathname];
      if (!route) throw Object.assign(new Error('refused by the transport'), { status: 403 });
      const answer = route(body);
      return {
        status: answer.status,
        statusText: answer.statusText,
        headers: answer.headers,
        body: (async function* () {
          if (answer.body) yield new TextEncoder().encode(answer.body);
        })(),
        cancel: async () => {},
      };
    },
  };
}

test('a transport that does not follow redirects: curl gets https through the CONNECT tunnel, a 302 unfollowed, every Set-Cookie, its request body, and the status a refusal carries', {
  timeout: 180_000,
}, async (t) => {
  const transport = ownTransport();
  const kernel = await createNodeKernel({ network: { transport } });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-curl', 'wasm-tls-engine']) await install(kernel, name);
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });

  const hello = await bash('curl -sS -f https://relay.test/hello');
  assert.deepEqual(hello, { status: 0, stdout: 'hello through the transport\n', stderr: '' });
  assert.equal(transport.seen.length, 1);
  assert.equal(transport.seen[0].url, 'https://relay.test/hello');
  assert.equal(transport.seen[0].method, 'GET');
  assert.ok(transport.seen[0].headers.some(([name]) => name.toLowerCase() === 'user-agent'));

  const moved = await bash('curl -sS -i http://relay.test/moved');
  assert.equal(moved.status, 0);
  assert.match(moved.stdout, /^HTTP\/1\.1 302 Found\r\n/);
  assert.match(moved.stdout, /\r\nlocation: \/hello\r\n/i);

  const cookies = await bash('curl -sS -D - -o /dev/null https://relay.test/hello');
  assert.deepEqual(cookies.stdout.match(/^set-cookie: .*$/gim), [
    'set-cookie: a=1; Path=/',
    'set-cookie: b=2; Path=/',
  ]);

  transport.seen.length = 0;
  const echo = await bash('curl -sS -w " %{http_code}" -d hello=world https://relay.test/echo');
  assert.equal(echo.stdout, 'echo hello=world 201');
  assert.equal(transport.seen[0].method, 'POST');
  assert.equal(transport.seen[0].body, 'hello=world');

  const refused = await bash('curl -sS -w " %{http_code}" https://relay.test/elsewhere');
  assert.equal(refused.status, 0);
  assert.match(refused.stdout, /refused by the transport/);
  assert.match(refused.stdout, / 403$/);
});
