import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a file bash holds open that vanishes from OPFS behind the kernel fails to read in a child, rather than reading back empty (#1198, #1336)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await bash('mkdir -p /root/hv && echo abcd > /root/hv/f && rm -f /root/hv/opened /root/hv/go', {
    cwd: '/',
  });
  await page.evaluate(() => {
    window.held = window.kernel.run(
      [
        'bash',
        '-c',
        'cd /root/hv; exec 3< f; : > opened; until [ -e go ]; do :; done; sleep 0; read -r v <&3; echo "[$v] rc=$?"',
      ],
      { cwd: '/' }
    );
  });
  while (!(await page.evaluate(() => window.opfs.exists('root/hv/opened'))))
    await new Promise((resolve) => setTimeout(resolve, 10));
  await page.evaluate(async () => {
    const top = await navigator.storage.getDirectory();
    const dir = await (await top.getDirectoryHandle('root')).getDirectoryHandle('hv');
    await dir.removeEntry('f');
    await window.opfs.write('root/hv/go', '');
  });
  const r = await page.evaluate(() => window.held);
  const read = r.stdout === '[abcd] rc=0\n';
  const failed = r.stdout === '[] rc=1\n' && /read error/.test(r.stderr);
  assert.ok(read || failed, `neither the bytes nor a read error: ${JSON.stringify(r)}`);
});
