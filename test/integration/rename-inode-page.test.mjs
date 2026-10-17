import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('in the page, a file made under a name just renamed away gets its own inode, also after a reload (#954)', async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  const check =
    'cd /home && f=$(stat -c %i f); n=$(stat -c %i t); [ "$f" != "$n" ] && echo apart; [ "$(stat -c %i s2)" != "$(stat -c %i s)" ] && echo apart';
  assert.deepEqual(
    await bash(`cd /home && : > t && mv t f && : > t && : > s && mv s s2 && ln -s x s; ${check}`),
    ok('apart\napart\n')
  );
  await page.reload();
  await page.until(() => typeof window.boot === 'function');
  await page.evaluate(() => window.boot({ users: 'enforce' }));
  await installPackage(page, 'wasm-coreutils');
  assert.deepEqual(await bash(check), ok('apart\napart\n'));
});

test('in the page, a placeholder held open, unlinked and replaced by a symlink keeps the symlink after the close (#954)', async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  assert.deepEqual(
    await bash(
      'mkdir -p /home/p/inner && echo first > /home/p/a.txt && cd /home/p/inner && for i in $(seq 30); do : > l$i; exec 3<>l$i; rm l$i; ln -s ../a.txt l$i; exec 3>&-; done; sleep 1.2; n=0; for i in $(seq 30); do [ "$(readlink l$i)" = ../a.txt ] && n=$((n + 1)); done; echo "kept=$n"; ls | wc -l'
    ),
    ok('kept=30\n30\n')
  );
});

test("in the page, the atomic-save pattern renamed over again and again reads back each cycle's own bytes (#954)", async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  assert.deepEqual(
    await bash(
      'mkdir -p /home/w && cd /home/w && echo 1 > g; echo 2 > g.tmp; mv g.tmp g; echo 3 > g; echo 4 > g.tmp; mv g.tmp g; echo "rc=$?"; cat g; n=0; for i in 1 2 3 4 5; do seq $((i * 300)) > k.tmp && mv k.tmp k && [ "$(tail -c 8 k)" = "$(seq $((i * 300)) | tail -c 8)" ] && [ "$(wc -c < k)" = "$(seq $((i * 300)) | wc -c)" ] && n=$((n + 1)); done; echo "cycles=$n"',
      { cwd: '/' }
    ),
    ok('rc=0\n4\ncycles=5\n')
  );
});
