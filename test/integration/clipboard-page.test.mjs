import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the page relays /dev/clipboard to its clipboard hook, refusals included', async (t) => {
  const { page, bash } = await booted(chrome, t, { clipboard: true, network: false });
  await page.evaluate(() => {
    window.clipboard.text = 'from the page';
  });
  assert.deepEqual(await bash('cat /dev/clipboard', { cwd: '/tmp' }), ok('from the page'));
  assert.deepEqual(
    await bash('printf "to the page" | cat > /dev/clipboard', { cwd: '/tmp' }),
    ok()
  );
  assert.equal(await page.evaluate(() => window.clipboard.text), 'to the page');
  const stamp = await page.evaluate(() => window.clipboard.calls.at(-1).stamp);
  assert.equal(stamp.uid, 0);
  assert.equal(typeof stamp.pid, 'number');
  await page.evaluate(() => {
    window.clipboard.refuse = true;
  });
  const refused = await bash('printf x | cat > /dev/clipboard; echo "rc=$?"', { cwd: '/tmp' });
  assert.deepEqual(refused, {
    status: 0,
    stdout: 'rc=1\n',
    stderr:
      'cat: /dev/clipboard: The clipboard needs the tab in front\ncat: write error: Permission denied\n',
  });
  const unread = await bash('cat /dev/clipboard', { cwd: '/tmp' });
  assert.equal(
    unread.stderr,
    'cat: /dev/clipboard: The clipboard needs the tab in front\ncat: /dev/clipboard: Permission denied\n'
  );
});
