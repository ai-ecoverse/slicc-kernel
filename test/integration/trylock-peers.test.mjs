import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const read = (page, path) =>
  page.until(async (p) => (await window.opfs.read(p))?.trim() || false, path);

test("an imports module's tryLock excludes across two kernels on one root, and closing the holder's tab releases it (#983)", async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(await bash('rm -rf /tmp/lt && mkdir -p /tmp/lt', { cwd: '/' }), ok());
  await page.evaluate(() => window.secondKernel({}));
  const hold = (path) =>
    page.evaluate((p) => {
      window.holding = window.second.run(['locktry', 'hold', p], { cwd: '/' });
      return true;
    }, path);
  const tryIn = (where, path) =>
    page.evaluate(
      (w, p) => window[w].run(['locktry', 'try', p], { cwd: '/' }).then((r) => r.status),
      where,
      path
    );
  await hold('/tmp/lt/a');
  assert.equal(await read(page, 'tmp/lt/a.hold'), 'held');
  assert.equal(await tryIn('kernel', '/tmp/lt/a'), 0);
  assert.equal(await read(page, 'tmp/lt/a.try'), '6');
  await page.evaluate(() => window.opfs.write('tmp/lt/a.release', ''));
  assert.equal((await page.evaluate(() => window.holding)).status, 0);
  await page.evaluate(() => window.opfs.write('tmp/lt/a.try', ''));
  assert.equal(await tryIn('kernel', '/tmp/lt/a'), 0);
  assert.equal(await read(page, 'tmp/lt/a.try'), '0');
  await page.evaluate(() => window.opfs.write('tmp/lt/a.release', ''));
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  await other.evaluate(() => {
    window.holding = window.kernel.run(['locktry', 'hold', '/tmp/lt/b'], { cwd: '/' });
    return true;
  });
  assert.equal(await read(page, 'tmp/lt/b.hold'), 'held');
  assert.equal(await tryIn('kernel', '/tmp/lt/b'), 0);
  assert.equal(await read(page, 'tmp/lt/b.try'), '6');
  await other.close();
  const freed = [];
  for (let i = 0; i < 20 && freed.at(-1) !== '0'; i++) {
    await page.evaluate(() => window.opfs.write('tmp/lt/b.try', ''));
    await tryIn('kernel', '/tmp/lt/b');
    freed.push(await read(page, 'tmp/lt/b.try'));
    if (freed.at(-1) !== '0') await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(freed.at(-1), '0', `after the holder's tab closed: ${freed.join(' ')}`);
});

test('a whole-file lock taken while a kernel was alone still excludes after a peer joins, and one taken while shared after the peer leaves (#983)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(await bash('rm -rf /tmp/lj && mkdir -p /tmp/lj', { cwd: '/' }), ok());
  const holdHere = (path) =>
    page.evaluate((p) => {
      window.holding = window.kernel.run(['locktry', 'hold', p], { cwd: '/' });
      return true;
    }, path);
  const tryHere = (path) =>
    page.evaluate(
      (p) => window.kernel.run(['locktry', 'try', p], { cwd: '/' }).then((r) => r.status),
      path
    );
  const sharedIs = (want) =>
    page.run(
      { maxMs: 60_000, label: `/proc/sys/kernel/slicc_shared_root reading ${want}` },
      async (w) => {
        for (;;) {
          const r = await window.kernel.run(
            ['bash', '-c', 'echo > /tmp/lj/tick; cat /proc/sys/kernel/slicc_shared_root'],
            { cwd: '/' }
          );
          if (r.stdout === `${w}\n`) return true;
          await new Promise((res) => setTimeout(res, 100));
        }
      },
      want
    );
  await sharedIs(0);
  await holdHere('/tmp/lj/a');
  assert.equal(await read(page, 'tmp/lj/a.hold'), 'held');
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  await sharedIs(1);
  assert.equal(await tryHere('/tmp/lj/a'), 0);
  assert.equal(await read(page, 'tmp/lj/a.try'), '6');
  await page.evaluate(() => window.opfs.write('tmp/lj/a.release', ''));
  await page.evaluate(() => window.holding);
  await holdHere('/tmp/lj/b');
  assert.equal(await read(page, 'tmp/lj/b.hold'), 'held');
  await other.close();
  await sharedIs(0);
  assert.equal(await tryHere('/tmp/lj/b'), 0);
  assert.equal(await read(page, 'tmp/lj/b.try'), '6');
  await page.evaluate(() => window.opfs.write('tmp/lj/b.release', ''));
  await page.evaluate(() => window.holding);
});
