import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('on the OPFS root, ctx.fs.watch reports renames and changes by name in order, and a file watch ends when its file goes (#1031)', async (t) => {
  const { bash } = await booted(chrome, t);
  const r = await bash(
    'rm -rf /tmp/w /tmp/r /tmp/r2; mkdir -p /tmp/w; echo old > /tmp/w/e; watchtest events /tmp/w end /tmp/r > /tmp/o1 & watchtest events /tmp/w/e end /tmp/r2 > /tmp/o2 & until [ -e /tmp/r ] && [ -e /tmp/r2 ]; do :; done; echo a > /tmp/w/a; mv /tmp/w/a /tmp/w/b; echo more >> /tmp/w/e; rm /tmp/w/e; touch /tmp/w/end; wait; cat /tmp/o1; echo --; cat /tmp/o2',
    { cwd: '/' }
  );
  assert.equal(r.status, 0, r.stderr);
  const [dir, file] = r.stdout.split('--\n').map((part) =>
    part
      .trim()
      .split('\n')
      .filter((line, i, all) => line !== all[i - 1])
  );
  assert.deepEqual(dir, [
    'rename a',
    'change a',
    'rename a',
    'rename b',
    'change e',
    'rename e',
    'rename end',
  ]);
  assert.deepEqual(file, ['change e', 'rename e', 'ended']);
});
