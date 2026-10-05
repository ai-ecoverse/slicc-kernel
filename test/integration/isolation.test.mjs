import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the test page and its nested dedicated workers can block on Atomics.wait', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.probe === 'function');

  const report = await page.evaluate(() => window.probe());
  assert.deepEqual(report, {
    isolated: true,
    workers: [
      { isolated: true, wait: 'timed-out' },
      { isolated: true, wait: 'timed-out' },
    ],
  });
  assert.deepEqual(page.errors, []);
});
