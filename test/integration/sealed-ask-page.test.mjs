import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const PH = 'fnox_proxy_0123456789abcdef01234567';

async function asked(page, count) {
  await page.until((n) => window.sealedAsk.asks.length >= n, count);
  return page.evaluate((n) => window.sealedAsk.asks[n - 1].req, count);
}

test('the page relays an ask past 10 s with the requester, and the value comes back unscrubbed', async (t) => {
  const { page, run } = await booted(chrome, t, { sealedAsk: true, network: false });
  const running = run(['sealed', 'ask', 'DEPLOY_TOKEN', '--reveal', '--prompt', 'for the deploy'], {
    cwd: '/tmp',
  });
  const req = await asked(page, 1);
  assert.equal(req.op, 'ask');
  assert.equal(req.name, 'DEPLOY_TOKEN');
  assert.equal(req.prompt, 'for the deploy');
  assert.equal(req.reveal, true);
  assert.equal(req.replace, false);
  assert.equal(req.caller.uid, 0);
  assert.deepEqual(req.requester, {
    exe: '/usr/bin/sealed',
    argv: ['sealed', 'ask', 'DEPLOY_TOKEN', '--reveal', '--prompt', 'for the deploy'],
    cwd: '/tmp',
    tty: null,
    stdin: 'none',
  });
  await delay(11_000);
  assert.deepEqual(await page.evaluate(() => window.sealedAsk.aborted), []);
  await page.evaluate(
    (ph) =>
      window.answerAsk(0, {
        v: 1,
        state: 'done',
        placeholder: ph,
        record: 'active',
        value: 'hunter22-value',
      }),
    PH
  );
  const done = await running;
  assert.deepEqual(
    { status: done.status, stdout: done.stdout, stderr: done.stderr },
    { status: 0, stdout: 'hunter22-value', stderr: '' }
  );
});

test('a killed asker withdraws its request on the page, and a denial exits 1', async (t) => {
  const { page, bash } = await booted(chrome, t, { sealedAsk: true, network: false });
  const running = bash('sealed ask K & echo $! > /tmp/asker; wait $!; echo "status $?"', {
    cwd: '/tmp',
  });
  await asked(page, 1);
  assert.deepEqual(await bash('kill -TERM "$(cat /tmp/asker)"', { cwd: '/tmp' }), {
    status: 0,
    stdout: '',
    stderr: '',
  });
  assert.equal((await running).stdout, 'status 143\n');
  await page.until(() => window.sealedAsk.aborted.length > 0);
  assert.deepEqual(await page.evaluate(() => window.sealedAsk.aborted), [
    { at: 0, reason: 'withdrawn' },
  ]);
  const denied = bash('sealed ask K; echo "status $?"', { cwd: '/tmp' });
  await asked(page, 2);
  await page.evaluate(() => window.answerAsk(1, { v: 1, state: 'cancelled' }));
  const r = await denied;
  assert.equal(r.stdout, 'status 1\n');
  assert.equal(r.stderr, 'sealed: K: cancelled\n');
});
