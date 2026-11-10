import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';
import { EIO, GRANT, STATUS } from './sealed-oauth-fixture.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the unchanged page relay carries atomic OAuth input and only strict safe replies return to the process', async (t) => {
  const { page, run } = await booted(chrome, t, { sealedAsk: true, network: false });
  const script = 'exec 3<>/dev/sealed; read -r line; printf "%s" "$line" >&3; cat <&3';
  const running = run(['bash', '-c', script], {
    cwd: '/',
    stdin: `${JSON.stringify({ ...GRANT, caller: { uid: 999 } })}\n`,
  });
  await page.until(() => window.sealedAsk.asks.length === 1);
  const { caller, ...fields } = await page.evaluate(() => window.sealedAsk.asks[0].req);
  assert.deepEqual(fields, GRANT);
  assert.equal(caller.uid, 0);
  await page.evaluate((reply) => window.answerAsk(0, reply), STATUS);
  assert.deepEqual(JSON.parse((await running).stdout), STATUS);
  const bad = run(['bash', '-c', script], { cwd: '/', stdin: `${JSON.stringify(GRANT)}\n` });
  await page.until(() => window.sealedAsk.asks.length === 2);
  await page.evaluate((reply) => window.answerAsk(1, reply), {
    ...STATUS,
    v: 2,
    refreshToken: 'fake-refresh-token',
  });
  assert.deepEqual(JSON.parse((await bad).stdout), EIO);
});
