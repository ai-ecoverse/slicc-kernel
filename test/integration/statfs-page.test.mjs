import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test("a JS program's statfs of the OPFS root is the origin's storage estimate", async (t) => {
  const { page, run } = await booted(chrome, t, { network: false });
  const measure = () =>
    page.evaluate(async () => {
      const { quota, usage } = await navigator.storage.estimate();
      return { quota, usage };
    });
  const estimate = await measure();
  const r = await run(['statfstest', '/'], { cwd: '/' });
  const later = await measure();
  assert.equal(r.status, 0, r.stderr);
  const { async: got, sync } = JSON.parse(r.stdout)['/'];
  assert.deepEqual(sync, got);
  assert.equal(got.bsize, 4096);
  const bounds = [estimate.quota, later.quota].map((quota) => Math.ceil(quota / 4096));
  assert.ok(
    got.blocks >= Math.min(...bounds) && got.blocks <= Math.max(...bounds),
    `${got.blocks} blocks, the estimates say ${bounds.join(' and ')}`
  );
  assert.ok(got.bfree > 0 && got.bfree <= got.blocks);
  assert.ok(Math.abs(got.bfree - Math.floor((estimate.quota - estimate.usage) / 4096)) < 4096);
});
