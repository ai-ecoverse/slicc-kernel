import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a directory renamed on the OPFS root keeps its files’ explicit mtimes (#1017)', async (t) => {
  const { bash } = await booted(chrome, t);
  const made = await bash(
    'rm -rf /home/mt && mkdir -p /home/mt/s/lib && cd /home/mt/s && echo a > a && echo b > lib/b && echo c > c && touch -d @1500000000 a lib/b && stat -c %Y c',
    { cwd: '/' }
  );
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(
    await bash(
      'mv /home/mt/s /home/mt/d && stat -c %Y /home/mt/d/a /home/mt/d/lib/b /home/mt/d/c',
      {
        cwd: '/',
      }
    ),
    ok(`1500000000\n1500000000\n${made.stdout}`)
  );
  assert.deepEqual(
    await bash('mv /home/mt/d/a /home/mt/d/lib/a && stat -c %Y /home/mt/d/lib/a', { cwd: '/' }),
    ok('1500000000\n')
  );
});
