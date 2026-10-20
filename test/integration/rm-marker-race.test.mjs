import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a directory rm leaves its vacated marker in the same metadata write, so another tab that stamps a replacement in between still gets a new inode (#1208)', async (t) => {
  const { page, bash } = await booted(chrome, t, { worker: '/rm-race-worker.js?race=/t/d' });
  assert.deepEqual(await bash('rm -rf /t && mkdir -p /t/d', { cwd: '/' }), ok());
  const before = await bash('stat -c %i /t/d', { cwd: '/' });
  assert.equal(before.status, 0, before.stderr);
  assert.deepEqual(await bash('rmdir /t/d', { cwd: '/' }), ok());
  await page.evaluate(async () => {
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('t');
    await top.getDirectoryHandle('d', { create: true });
  });
  const now = await bash('stat -c %i /t/d', { cwd: '/' });
  assert.equal(now.status, 0, now.stderr);
  assert.notEqual(now.stdout, before.stdout);
});
