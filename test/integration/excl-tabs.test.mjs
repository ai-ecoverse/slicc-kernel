import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const race = (prefix, n, down = false) =>
  `for i in $(seq ${down ? `${n} -1 1` : `1 ${n}`}); do ( set -C; : > /home/${prefix}$i ) 2>/dev/null && echo $i; done; true`;

async function secondTab(page) {
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  return (script) =>
    other.evaluate((s) => window.kernel.run(['bash', '-c', s], { cwd: '/' }), script);
}

function winners(...outs) {
  const all = outs.flatMap((o) => o.stdout.split('\n').filter(Boolean)).map(Number);
  return all.sort((a, b) => a - b);
}

const each = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('an exclusive create of the same names in two tabs at once has exactly one winner per name (#912)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const there = await secondTab(page);
  const [mine, theirs] = await Promise.all([
    bash(race('r', 20), { cwd: '/' }),
    there(race('r', 20)),
  ]);
  assert.deepEqual(winners(mine, theirs), each(20));
});

const slots = (seconds) =>
  `end=$(( \${EPOCHREALTIME/./} + ${seconds}000000 )); while (( \${EPOCHREALTIME/./} < end )); do s=$(( \${EPOCHREALTIME/./} / 40000 )); ( set -C; : > /home/t$s ) 2>/dev/null && echo $s; done; true`;

test('a tab that boots while another is in the middle of its exclusive creates still leaves one winner per name (#912)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const first = bash(slots(12), { cwd: '/' });
  const there = await secondTab(page);
  const second = there(slots(6));
  const [mine, theirs] = [await first, await second];
  const all = winners(mine, theirs);
  assert.ok(theirs.stdout.trim().length > 0, 'the second tab created some');
  assert.deepEqual(all, [...new Set(all)]);
});
