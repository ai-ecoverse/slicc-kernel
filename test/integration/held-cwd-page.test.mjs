import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

for (const [name, replace] of [
  ['rm -r d; mv n d', 'mkdir /t/n && touch /t/n/x && rm -r /t/d && mv /t/n /t/d'],
  ['rm -r d; mkdir d', 'rm -r /t/d && mkdir /t/d && touch /t/d/x'],
]) {
  test(`on the OPFS root, a wasip1 program keeps a cwd that another tab replaces by "${name}" as the removed directory (#1164)`, async (t) => {
    const { page, bash } = await booted(chrome, t);
    await page.evaluate(
      (n) => window.copyTree('fixtures/heldcwd/', 'node_modules/heldcwd/', n),
      ['package.json', 'bin/heldcwd.wasm']
    );
    assert.deepEqual(
      await bash('rm -rf /t && mkdir -p /t/d /t/s && touch /t/d/old', { cwd: '/' }),
      ok()
    );
    const out = await page.evaluate(async (script) => {
      await window.secondKernel({});
      const held = window.kernel.run(
        [
          'bash',
          '-c',
          'cd /t/d && { until [ -e /t/s/go ]; do sleep 0.05; done; echo; } | heldcwd > /t/s/out; cd /; cat /t/s/out',
        ],
        { cwd: '/' }
      );
      const end = Date.now() + 60_000;
      while (Date.now() < end) {
        const r = await window.second.run(['bash', '-c', 'test -s /t/s/out'], { cwd: '/' });
        if (r.status === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const replaced = await window.second.run(['bash', '-c', `${script} && touch /t/s/go`], {
        cwd: '/',
      });
      return { replaced, held: await held };
    }, replace);
    assert.equal(out.replaced.status, 0, out.replaced.stderr);
    assert.equal(
      out.held.stdout,
      'before [old]\nafter error entity not found\ncreate NotFound\nstat NotFound\nparent [d,s]\n',
      out.held.stderr
    );
  });
}

test('on the OPFS root, bash keeps a cwd that another tab replaces: ls fails, a glob matches nothing, and cd .. reaches the new one (#1164)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('rm -rf /t && mkdir -p /t/d /t/s && touch /t/d/old', { cwd: '/' }),
    ok()
  );
  const out = await page.evaluate(async () => {
    await window.secondKernel({});
    const held = window.kernel.run(
      [
        'bash',
        '-c',
        'cd /t/d && touch /t/s/ready && until [ -e /t/s/go ]; do sleep 0.05; done; ls; echo "ls=$?"; echo *; cd .. && ls d',
      ],
      { cwd: '/' }
    );
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const r = await window.second.run(['bash', '-c', 'test -e /t/s/ready'], { cwd: '/' });
      if (r.status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const replaced = await window.second.run(
      ['bash', '-c', 'mkdir /t/n && touch /t/n/x && rm -r /t/d && mv /t/n /t/d && touch /t/s/go'],
      { cwd: '/' }
    );
    return { replaced, held: await held };
  });
  assert.equal(out.replaced.status, 0, out.replaced.stderr);
  assert.equal(out.held.stdout, 'ls=2\n*\nx\n', out.held.stderr);
});
