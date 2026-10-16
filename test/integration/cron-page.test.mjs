import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const LOG = '/var/log/cron/root/up.log';
const runs = (log) => (log ?? '').split('\n').filter((line) => line.startsWith('--- '));

test('on a page, a crontab survives a reload, @reboot runs once per boot, and of two tabs on one origin only one fires until it ends', async (t) => {
  const { page, run } = await booted(chrome, t, { network: false });
  const bash = (script, options = {}) => run(['bash', '-c', script], { cwd: '/root', ...options });
  const table = '# name: up\n@reboot echo "up $SLICC_CRON_MISSED"\n';
  assert.equal((await bash('crontab -', { stdin: table })).status, 0);
  await delay(1000);
  assert.equal((await bash(`cat ${LOG}`)).status, 1);
  await page.reload();
  await page.until(() => typeof window.boot === 'function');
  await page.evaluate(() => window.boot({ network: false }));
  assert.deepEqual(await bash('crontab -l'), { status: 0, stdout: table, stderr: '' });
  const until = async (count, what) => {
    for (let i = 0; i < 100; i++) {
      const log = (await bash(`cat ${LOG}`)).stdout;
      if (runs(log).length >= count) return log;
      await delay(100);
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const first = await until(1, 'the reboot run');
  assert.match(first, /^--- \S+Z exit=0 missed=0 ---\nup 0\n$/);
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({ network: false }));
  const otherLog = async () =>
    (
      await other.evaluate(() =>
        window.kernel.run(['bash', '-c', 'cat /var/log/cron/root/up.log'], { cwd: '/' })
      )
    ).stdout;
  assert.equal(
    (await other.evaluate(() => window.kernel.run(['crontab', '-l'], { cwd: '/' }))).stdout,
    table
  );
  await delay(1500);
  assert.equal(runs(await otherLog()).length, 1);
  await page.evaluate(() => window.kernel.terminate());
  let log = '';
  for (let i = 0; i < 100 && runs(log).length < 2; i++) {
    await delay(100);
    log = await otherLog();
  }
  assert.equal(runs(log).length, 2, log);
  await delay(1500);
  assert.equal(runs(await otherLog()).length, 2);
});
