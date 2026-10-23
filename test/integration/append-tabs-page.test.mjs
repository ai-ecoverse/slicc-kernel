import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const N = 200;
const appender = (tag) =>
  [
    'import os',
    "f = '/root/ap/log'",
    "while not os.path.exists('/root/ap/go'): pass",
    'fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)',
    'ok = 0',
    `for n in range(${N}):`,
    `    os.write(fd, b'${tag}%d\\n' % n); os.fsync(fd); ok += 1`,
    'os.close(fd)',
    'print(ok)',
  ].join('\n');

test('O_APPEND writes from two tabs to one file all land, as two processes on one Linux file (#1520)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  assert.deepEqual(
    await sh(page, 'rm -rf /root/ap && mkdir -p /root/ap && echo made'),
    ok('made\n')
  );
  for (const [tab, tag] of [
    [page, 'x'],
    [other, 'y'],
  ]) {
    await tab.evaluate(
      ([s, g]) => {
        window[`append_${g}`] = window.kernel.run(['python3', '-c', s], { cwd: '/' });
      },
      [appender(tag), tag]
    );
  }
  await sleep(2000);
  await sh(page, ': > /root/ap/go');
  const x = await page.evaluate(() => window.append_x);
  const y = await other.evaluate(() => window.append_y);
  assert.deepEqual([x.stdout, y.stdout], [`${N}\n`, `${N}\n`], JSON.stringify([x, y]));
  const counted = await sh(
    page,
    "grep -c '^x' /root/ap/log; grep -c '^y' /root/ap/log; wc -l < /root/ap/log"
  );
  assert.deepEqual(counted, ok(`${N}\n${N}\n${2 * N}\n`));
});
