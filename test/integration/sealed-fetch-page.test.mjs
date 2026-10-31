import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const PH = 'fnox_proxy_0123456789abcdef01234567';
const REFUSED = /refused: the request with a sealed placeholder was not completed/;

const chrome = await launch();
after(() => chrome.close());

const curl = (args) => `curl -sS -w ' %{http_code}' -H 'Authorization: Bearer ${PH}' ${args}`;

test('curl on the page reaches the fetch hook through the worker relay, and a refusal comes back', async (t) => {
  const { page, bash } = await booted(chrome, t, { sealedFetch: true });
  const filled = await bash(curl('-d hello https://fake.test/ordinary'), { cwd: '/tmp' });
  assert.equal(filled.stdout, 'scrubbed reply 200');
  const [call] = await page.evaluate(() => window.sealedFetch.calls);
  assert.equal(call.caller.uid, 0);
  assert.equal(call.caller.users, 'enforce');
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://fake.test/ordinary');
  assert.equal(call.sent, 'hello');

  for (const mode of ['throw', 'hops']) {
    await page.evaluate((m) => {
      window.sealedFetch.mode = m;
    }, mode);
    const { stdout } = await bash(curl('https://fake.test/ordinary'), { cwd: '/tmp' });
    assert.match(stdout, REFUSED);
    assert.match(stdout, / 403$/);
  }
});

test('terminating the kernel aborts a hook that is waiting on the page', async (t) => {
  const { page, bash } = await booted(chrome, t, { sealedFetch: true });
  await page.evaluate(() => {
    window.sealedFetch.mode = 'hang';
  });
  const running = bash(curl('https://fake.test/ordinary'), { cwd: '/tmp' }).catch(() => undefined);
  await page.until(() => window.sealedFetch.calls.length === 1);
  await page.evaluate(() => window.kernel.terminate());
  await page.until(() => window.sealedFetch.stopped.length === 1);
  await running;
});

test('setPlaceholders, the tombstone and the version reach the page entry', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const custom = 'vault_token_not_of_the_syntax';
  await page.evaluate((list) => window.kernel.sealed.setPlaceholders(list), [custom]);
  const { stdout } = await bash(
    `curl -sS -w ' %{http_code}' -H 'x-api-key: ${custom}' https://fake.test/`,
    { cwd: '/tmp' }
  );
  assert.match(stdout, /refused: this request has a sealed placeholder/);
  await bash('mkdir -p /etc/slicc', { cwd: '/' });
  const gone = await page.evaluate(() =>
    window.kernel.attest('/etc/slicc/gone.toml', { absent: 'allow' })
  );
  assert.deepEqual(Object.keys(gone).sort(), ['absent', 'onRootFs', 'parents', 'path', 'users']);
  assert.equal(gone.absent, true);
  const refused = await page.evaluate(() =>
    window.kernel.attest('/etc/missing/gone.toml', { absent: 'allow' }).then(
      () => '',
      (e) => e.code
    )
  );
  assert.equal(refused, 'ENOENT');
  const version = await page.evaluate(
    async () => (await import('/dist/index.js')).SEALED_FETCH_VERSION
  );
  assert.equal(version, 1);
});
