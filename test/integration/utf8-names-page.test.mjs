import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const NAMES = ['café.txt', 'Ünïcödé', '日本語.txt', '😀 emoji.txt'];
const quoted = NAMES.map((n) => `'${n}'`).join(' ');

for (const users of ['enforce', 'off']) {
  test(`in the browser on OPFS, names with é, ü, CJK and emoji are created, stat'd, listed, renamed and removed (users: ${users})`, async (t) => {
    const { page, bash, list } = await booted(chrome, t, { users });
    await installPackage(page, 'wasi-ripgrep');
    const made = await bash(
      `mkdir -p /home/u && cd /home/u && for n in ${quoted}; do printf '%s' "$n" > "$n" || exit 1; done; mkdir 'dir ü' && for n in ${quoted}; do stat -c '%F %s' "$n"; done; mv 'café.txt' '名前.txt'; cat '名前.txt'; echo`,
      { cwd: '/home' }
    );
    assert.deepEqual(made, {
      status: 0,
      stdout: [...NAMES.map((n) => `regular file ${Buffer.byteLength(n)}`), 'café.txt', ''].join(
        '\n'
      ),
      stderr: '',
    });
    const want = ['Ünïcödé', '日本語.txt', '😀 emoji.txt', '名前.txt'].sort();
    assert.deepEqual((await list('home/u')).sort(), [...want, 'dir ü'].sort());
    const rg = await bash("cd /home/u && rg --files | LC_ALL=C sort && rg -l '日本' .", {
      cwd: '/home',
    });
    assert.equal(rg.status, 0, rg.stderr);
    assert.deepEqual(rg.stdout.trim().split('\n'), [
      ...[...want].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
      './日本語.txt',
    ]);
    const gone = await bash('cd /home/u && rm -rf -- * && ls -A | wc -l', { cwd: '/home' });
    assert.deepEqual(gone, { status: 0, stdout: '0\n', stderr: '' });
    assert.deepEqual(await list('home/u'), []);
    assert.deepEqual(page.errors, []);
  });
}
