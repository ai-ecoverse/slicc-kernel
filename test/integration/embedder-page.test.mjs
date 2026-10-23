import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the page answers /dev/embedder through its requests hook, and a port it binds at connect answers for that port: the body streams in, the reply out, progress and a refusal reach the program (#1527)', async (t) => {
  const { page, bash } = await booted(chrome, t, { requests: true, network: false });
  const echo = await bash(
    `exec 3<>/dev/embedder; { printf '%s\\n' '{"kind":"page.echo","n":2}'; head -c 300000 /dev/zero | tr '\\0' a; } >&3; cat <&3 | wc -c`,
    { cwd: '/tmp' }
  );
  assert.equal(echo.stdout.trim(), String(300000 + 5), echo.stderr);
  assert.match(echo.stderr, /echoing/);
  const refused = await bash(
    `printf '%s\\n' '{"kind":"page.fail"}' | cat > /dev/embedder; echo "rc=$?"`,
    { cwd: '/tmp' }
  );
  assert.equal(refused.stdout, 'rc=1\n');
  assert.match(refused.stderr, /cat: \/dev\/embedder: the page said no/);
  const unlisted = await bash(
    `printf '%s\\n' '{"kind":"page.other"}' | cat > /dev/embedder; echo "rc=$?"`,
    { cwd: '/tmp' }
  );
  assert.equal(unlisted.stdout, 'rc=1\n');
  const bound = await page.evaluate(
    (script) => window.boundRun(script),
    `printf '%s\\n' '{"kind":"page.echo"}' | cat > /dev/embedder; exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"page.echo"}' >&3; cat <&3`
  );
  assert.equal(bound.stdout, 'bound', JSON.stringify(bound));
  const counted = await bash(
    `head -c 4000000 /dev/zero > in; exec 3<>/dev/embedder; { printf '%s\\n' '{"kind":"page.count"}'; cat in; } >&3; cat <&3`,
    { cwd: '/tmp' }
  );
  assert.equal(counted.stdout, '4000000', JSON.stringify(counted));
  const held = await bash(
    `head -c 4000000 /dev/zero > in; exec 3<>/dev/embedder; { printf '%s\\n' '{"kind":"page.held"}'; cat in; } >&3; echo "w $?"; cat <&3`,
    { cwd: '/tmp' }
  );
  assert.equal(held.stdout, 'w 0\nok', JSON.stringify(held));
  const heldWo = await bash(
    `{ printf '%s\\n' '{"kind":"page.held"}'; head -c 2097152 /dev/zero; } | cat > /dev/embedder; echo "rc=$?"`,
    { cwd: '/tmp' }
  );
  assert.equal(heldWo.stdout, 'rc=0\n', JSON.stringify(heldWo));
  const calls = await page.evaluate(() => window.requests.calls);
  assert.deepEqual(
    calls.map((c) => [c.kind, c.options, c.stamp.uid]),
    [
      ['page.echo', { n: 2 }, 0],
      ['page.fail', {}, 0],
      ['bound page.echo', {}, 0],
      ['bound page.echo', {}, 0],
      ['page.count', {}, 0],
      ['page.held', {}, 0],
      ['page.held', {}, 0],
    ]
  );
});
