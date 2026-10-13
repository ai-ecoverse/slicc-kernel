import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a write moves the mtime to now, also after an explicit time: overwrite, append, truncate, and an append to a plain file', async (t) => {
  const { bash } = await booted(chrome, t);
  const script = [
    'echo one > w; touch -d @1577934245 w; echo two > w; a=$(stat -c %Y w)',
    'echo one > x; touch -d @1577934245 x; echo two >> x; b=$(stat -c %Y x)',
    'echo one > y; touch -d @1577934245 y; truncate -s 1 y; c=$(stat -c %Y y)',
    'echo one > z; touch -d @1577934245 z; d=$(stat -c %Y z)',
    'echo one > v; e1=$(stat -c %Y v); sleep 2.2; echo two >> v; e2=$(stat -c %Y v); echo "plain $((e2 - e1))"',
    'now=$(date +%s); for v in $a $b $c; do [ $((now - v)) -lt 60 ] && echo now || echo "old $v"; done; echo $d',
  ].join('; ');
  const r = await bash(script);
  const [plain, ...rest] = r.stdout.trim().split('\n');
  assert.deepEqual(rest, ['now', 'now', 'now', '1577934245']);
  assert.ok(Number(plain.split(' ')[1]) >= 2, plain);
});
