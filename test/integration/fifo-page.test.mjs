import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a FIFO on OPFS keeps its type and carries data between two processes (#896)', async (t) => {
  const { bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('mkfifo /home/f && stat -c "%F" /home/f && ls -l /home/f | cut -c1'),
    ok('fifo\np\n')
  );
  assert.deepEqual(
    await bash(
      'cat /home/f > /home/out & sleep 0.3; echo "through opfs" > /home/f; wait; cat /home/out'
    ),
    ok('through opfs\n')
  );
});
