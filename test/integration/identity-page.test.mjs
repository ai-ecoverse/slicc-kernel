import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const same = (line) => {
  const ids = [...line.matchAll(/\d+:\d+/g)].map((m) => m[0]);
  return ids.length > 0 && ids.every((id) => id === ids[0]) ? ids[0] : `mismatch ${line}`;
};

test('on the OPFS root a file has one dev:ino across stat, lstat, fstat and fstatat, in WASIX, WASI and Emscripten programs, also kept by a rename (#1287)', async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await page.evaluate(
    (n) => window.copyTree('fixtures/idtest/', 'node_modules/idtest/', n),
    ['package.json', 'bin/idtest.wasm']
  );
  const py =
    'import os,sys; p=sys.argv[1]; fd=os.open(p,os.O_RDONLY); s=[os.stat(p),os.lstat(p),os.fstat(fd),os.stat(p,dir_fd=None)]; print(" ".join("%d:%d"%(x.st_dev,x.st_ino) for x in s))';
  const r = await bash(
    [
      'mkdir -p /home/cone/h2 && cd /home/cone/h2 && echo x > f',
      'idtest f',
      `python3 -c '${py}' f`,
      'echo "$(stat -c %d:%i f) $(stat -L -c %d:%i f) $(exec 3< f; stat -L -c %d:%i /dev/fd/3)"',
      'idtest trustdb.gpg new',
      'mv f g && idtest g',
      'echo y > a && ln -s a l && idtest l',
    ].join('\n'),
    { cwd: '/' }
  );
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  const [wasix, wasi, emscripten, created, renamed, link] = lines;
  const id = same(wasix);
  assert.equal(same(wasi), id, wasi);
  assert.equal(same(emscripten), id, emscripten);
  assert.match(same(created), /^\d+:\d+$/, created);
  assert.equal(same(renamed), id, renamed);
  const [stat, lstat, fstat, fstatat] = [...link.matchAll(/\d+:\d+/g)].map((m) => m[0]);
  assert.notEqual(lstat, stat, link);
  assert.deepEqual([fstat, fstatat], [stat, stat], link);
});
