import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('git commits, and clones over the pack protocol: upload-pack piped into index-pack', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-git');

  const script = [
    "git config --global user.name kernel && git config --global user.email kernel@example.com && git config --global --add safe.directory '*'",
    'git init -q /home/origin && cd /home/origin',
    'echo hello > a.txt && git add a.txt && git commit -qm first',
    'git clone -q --no-local /home/origin /home/copy',
    'cat /home/copy/a.txt && git -C /home/copy log --format=%s',
  ].join(' && ');
  assert.deepEqual(await bash(script, { cwd: '/home' }), ok('hello\nfirst\n'));
  assert.deepEqual(page.errors, []);
});

test('git fetches into a clone, reading the pack at the offsets it asks for (pread)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-git');

  const script = [
    "git config --global user.name kernel && git config --global user.email kernel@example.com && git config --global --add safe.directory '*'",
    'git config --global init.defaultBranch master',
    'git init -q --bare /home/g/repo.git && git init -q -b main /home/g/w && cd /home/g/w',
    'echo hello > a.txt && git add a.txt && git commit -qm first',
    'git remote add origin /home/g/repo.git && git push -q origin main',
    'cd /home/g && git clone -q file:///home/g/repo.git c2 2>/dev/null && cd c2',
    'git fetch -q origin && git log --format=%s origin/main',
  ].join(' && ');
  assert.deepEqual(await bash(script, { cwd: '/home' }), ok('first\n'));
});
