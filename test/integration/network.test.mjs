import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const latest = 'https://registry.npmjs.org/@ai-ecoverse/wasm-bash/latest';

test('curl fetches registry metadata over https through the realm proxy', async (t) => {
  const { page, bash } = await booted(chrome, t);

  const { status, stdout, stderr } = await bash(`curl -sS -f ${latest}`);
  assert.equal(stderr, '');
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).name, '@ai-ecoverse/wasm-bash');
  assert.deepEqual(page.errors, []);
});

test('programs start with the proxy and the CA bundle in their environment', async (t) => {
  const { bash, read } = await booted(chrome, t);

  const { stdout } = await bash('echo "$https_proxy $CURL_CA_BUNDLE"');
  assert.equal(stdout, 'http://127.0.0.1:3128 /etc/ssl/certs/slicc-kernel-ca.pem\n');
  assert.match(await read('etc/ssl/certs/slicc-kernel-ca.pem'), /^-----BEGIN CERTIFICATE-----/);
});

test('without a transport, a request is answered 502 naming the missing option', async (t) => {
  const { bash } = await booted(chrome, t, { network: false });

  const { status, stdout } = await bash(`curl -sS ${latest}`);
  assert.equal(status, 0);
  assert.match(stdout, /no network transport \(createKernel\(\{ network: \{ transport \} \}\)\)/);
});
