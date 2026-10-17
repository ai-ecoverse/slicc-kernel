import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const DEEP = '/tmp/cl/a/b/c/d/e/f/g/h';
const LOOKUPS = 2000;

const shared = (page) =>
  page.evaluate(async () => {
    const r = await window.kernel.run(['cat', '/proc/sys/kernel/slicc_shared_root'], { cwd: '/' });
    return r.stdout.trim();
  });

test('a tab that closes stops counting as a peer at once, without waiting for a write to prune it (#984)', async (t) => {
  const { page } = await booted(chrome, t);
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  assert.equal(await shared(page), '1');
  await other.close();
  const seen = [];
  for (let i = 0; i < 30 && seen.at(-1) !== '0'; i++) {
    seen.push(await shared(page));
    if (seen.at(-1) !== '0') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(seen.at(-1), '0', `after the peer's tab closed: ${seen.join(' ')}`);
});

test('with an idle peer on the root, a program looking up names deep in a tree costs at most a few times what it costs alone (#984)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash(`rm -rf /tmp/cl && mkdir -p ${DEEP} && : > ${DEEP}/x`, { cwd: '/' }),
    ok()
  );
  const lookups = `n=0; for i in $(seq ${LOOKUPS}); do [ -e ${DEEP}/x ] && n=$((n + 1)); [ -e ${DEEP}/y$i ] || n=$((n + 1)); done; echo "n=$n"`;
  const timed = async () => {
    const t0 = Date.now();
    assert.deepEqual(await bash(lookups, { cwd: '/' }), ok(`n=${2 * LOOKUPS}\n`));
    return Date.now() - t0;
  };
  const alone = await timed();
  await page.evaluate(() => window.secondKernel({}));
  assert.equal(await shared(page), '1');
  const peered = await timed();
  assert.ok(peered < 4 * alone, `alone ${alone} ms, with a peer ${peered} ms`);
});

test('a directory another kernel renames while a program keeps it cached shows the new layout at the program’s next lookup (#984, #959)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('rm -rf /tmp/cr && mkdir -p /tmp/cr/d && echo old > /tmp/cr/d/f', { cwd: '/' }),
    ok()
  );
  const r = await page.evaluate(async () => {
    await window.secondKernel({});
    const reader = window.kernel.run(
      [
        'bash',
        '-c',
        'read -r a < /tmp/cr/d/f; [ -d /tmp/cr/d ] && : > /tmp/cr/ready; while [ ! -e /tmp/cr/go ]; do sleep 0.05; done; read -r b < /tmp/cr/d/f; read -r c < /tmp/cr/e/f; echo "$a $b $c"',
      ],
      { cwd: '/' }
    );
    const writer = window.second.run(
      [
        'bash',
        '-c',
        'while [ ! -e /tmp/cr/ready ]; do sleep 0.05; done; mv /tmp/cr/d /tmp/cr/e && mkdir /tmp/cr/d && echo new > /tmp/cr/d/f && : > /tmp/cr/go',
      ],
      { cwd: '/' }
    );
    return Promise.all([reader, writer]);
  });
  assert.deepEqual(r[1], ok());
  assert.deepEqual(r[0], ok('old new old\n'));
});
