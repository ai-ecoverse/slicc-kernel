import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch } from './chrome.mjs';

test('browser memory lease kernels run only their sealed released CLI and never persist job files', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const page = await chrome.page(t);
  await page.goto('/fixtures/cdp/page.html');
  const before = await page.evaluate(async () =>
    (await import('/fixtures/lease-memory-page.mjs')).observe()
  );
  const r = await page.evaluate(async () =>
    (await import('/fixtures/lease-memory-page.mjs')).isolation()
  );
  for (const obs of r.snapshots) assert.deepEqual(obs, before);
  assert.deepEqual(
    await page.evaluate(async () => (await import('/fixtures/lease-memory-page.mjs')).observe()),
    before
  );
  assert.equal(r.missing, 'ENOENT');
  assert.equal(r.fresh, 'ENOENT');
  assert.equal(r.listed, false);
  assert.deepEqual(r.files, ['first job only', 'second job only']);
  assert.equal(r.remaining, 'second job only');
  assert.equal(r.extra, 'EACCES');
  assert.equal(r.script, 'EACCES');
  assert.equal(r.quota, 'ENOSPC');
  assert.equal(r.late, 'EPERM');
  assert.ok(
    r.refusals.every((c) => ['EACCES', 'EROFS', 'EPERM'].includes(c)),
    JSON.stringify(r.refusals)
  );
  assert.equal(r.req.status, 0, r.req.stderr);
  assert.ok(r.req.stdout.includes(`slicc lease review --to jkt:${r.jkt}`));
  assert.deepEqual([r.snap.status, r.snap.stdout], [0, 'fixture document\n']);
  assert.equal(JSON.parse(r.write.stderr).reason, 'E_UNSUPPORTED');
  assert.equal(r.user.length, 2);
  assert.ok(r.user.every((u) => u > 0));
  const failed = await page.evaluate(async () =>
    (await import('/fixtures/lease-memory-page.mjs')).bootFailures()
  );
  assert.ok(
    failed.errors.every((e) => /boot option|cdpLease/.test(e)),
    JSON.stringify(failed)
  );
  assert.deepEqual(
    [failed.early, failed.oversize, failed.bad, failed.sealed],
    ['EACCES', 'EINVAL', 'EACCES', 'EPERM']
  );
  const entries = await page.evaluate(async () =>
    (await import('/fixtures/lease-memory-page.mjs')).entries()
  );
  assert.ok(entries.count > 0 && entries.count < 4096, JSON.stringify(entries));
  assert.equal(entries.refusal, 'ENOSPC');
  assert.equal(entries.existing, true);
});
