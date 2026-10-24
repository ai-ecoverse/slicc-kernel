import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { PEER_WORKER, peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const held = async (tab) => (await sh(tab, 'cat /proc/sys/kernel/slicc_peer_held')).stdout;

const until = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const holding = (page, path) =>
  page.evaluate((p) => {
    window.holding = window.kernel.run(
      ['bash', '-c', `exec 3< ${p}; until [ -e /root/pfgo ]; do :; done; exec 3<&-`],
      { cwd: '/' }
    );
  }, path);

test("a held file's peers follow it when it is renamed, by this tab or another one, and when its directory is (#1409)", {
  timeout: 900_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  assert.deepEqual(
    await sh(page, 'rm -rf /root/pf && mkdir -p /root/pf/d && echo x > /root/pf/d/f && echo made'),
    ok('made\n')
  );
  await holding(page, '/root/pf/d/f');
  assert.ok(await until(async () => (await held(other)) === '/root/pf/d/f\n'), await held(other));
  assert.deepEqual(await sh(page, 'mv /root/pf/d/f /root/pf/d/g && echo moved'), ok('moved\n'));
  assert.ok(
    await until(async () => (await held(other)) === '/root/pf/d/g\n'),
    `local: ${await held(other)}`
  );
  assert.deepEqual(await sh(other, 'mv /root/pf/d/g /root/pf/d/h && echo moved'), ok('moved\n'));
  assert.ok(
    await until(async () => (await held(other)) === '/root/pf/d/h\n'),
    `peer: ${await held(other)}`
  );
  assert.deepEqual(await sh(other, 'mv /root/pf/d /root/pf/e && echo moved'), ok('moved\n'));
  assert.ok(
    await until(async () => (await held(other)) === '/root/pf/e/h\n'),
    `dir: ${await held(other)}`
  );
  await sh(page, ': > /root/pfgo');
  assert.equal((await page.evaluate(() => window.holding)).status, 0);
  assert.ok(await until(async () => (await held(other)) === ''), `closed: ${await held(other)}`);
});

test('opens of an existing file do not each wait for a peer that has gone silent (#1409)', {
  timeout: 900_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page, { worker: '/rename/pause-worker.js?id=p' });
  assert.deepEqual(
    await sh(page, 'mkdir -p /root/ps && echo x > /root/ps/f && echo made'),
    ok('made\n')
  );
  await other.evaluate(
    () =>
      new Promise((resolve) => {
        const channel = new BroadcastChannel('pause-control');
        channel.onmessage = ({ data }) => data?.done === 1 && resolve();
        channel.postMessage({ id: 'p', set: { freeze: true }, seq: 1 });
      })
  );
  const script = [
    'import os, time',
    't = time.time()',
    'for _ in range(50):',
    "    os.close(os.open('/root/ps/f', os.O_RDONLY))",
    'print(round((time.time() - t) * 1000))',
  ].join('\n');
  const r = await page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    script
  );
  const out = typeof r.stdout === 'string' ? r.stdout : new TextDecoder().decode(r.stdout);
  console.log(`50 opens with a frozen peer: ${out.trim()} ms`);
  await other.evaluate(() =>
    new BroadcastChannel('pause-control').postMessage({ id: 'p', thaw: true })
  );
  assert.ok(Number(out) < (50 * 500) / 5, `${out.trim()} ms for 50 opens`);
});

test('opens of an existing file never wait for a tab running an older kernel, which does not ack holds (#1409 review)', {
  timeout: 900_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const old = await peerTab(page, { worker: `${PEER_WORKER}?old=1` });
  assert.deepEqual(
    await sh(page, 'rm -rf /root/po && mkdir -p /root/po && echo x > /root/po/f && echo made'),
    ok('made\n')
  );
  const script = [
    'import os, time',
    't = time.time()',
    'for _ in range(50):',
    "    os.close(os.open('/root/po/f', os.O_RDONLY))",
    'print(round((time.time() - t) * 1000))',
  ].join('\n');
  await old.evaluate(() => {
    window.busy = window.kernel.run(
      [
        'bash',
        '-c',
        'until [ -e /root/po/stop ]; do echo 1 > /root/po/w; mv /root/po/w /root/po/v; done',
      ],
      { cwd: '/' }
    );
  });
  const r = await page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    script
  );
  await sh(page, ': > /root/po/stop');
  await old.evaluate(() => window.busy);
  const out = typeof r.stdout === 'string' ? r.stdout : new TextDecoder().decode(r.stdout);
  console.log(`50 opens with an older-kernel peer: ${out.trim()} ms`);
  assert.ok(Number(out) < 1000, `${out.trim()} ms for 50 opens`);
});
