import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const WRITER = `import os
while not os.path.exists('reading'):
    pass
for i in range(300):
    with open('g.tmp', 'w') as f:
        f.write(str(i) * 100)
    os.rename('g.tmp', 'g')
open('done', 'w').close()
`;

const HOLDER = `import os
kept = open('g')
open('holding', 'w').close()
while not os.path.exists('done'):
    pass
`;

const READER = `import os
while not os.path.exists('holding'):
    pass
open('reading', 'w').close()
n = missing = empty = 0
while not os.path.exists('done'):
    n += 1
    try:
        with open('g') as f:
            if f.read() == '':
                empty += 1
    except FileNotFoundError:
        missing += 1
print(f'n={n} reads={n > 50} enoent={missing} empty={empty}', flush=True)
`;

test('in the browser on OPFS, a WASIX rename over a file that other WASIX processes hold and keep opening is atomic: no open finds no file or an empty one (#903)', async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  for (const name of ['wasm-coreutils', 'wasix-python']) await installPackage(page, name);
  const b64 = (s) => Buffer.from(s).toString('base64');
  const r = await bash(
    `mkdir -p /home/u && cd /home/u && echo start > g && echo ${b64(WRITER)} | base64 -d > writer.py && echo ${b64(READER)} | base64 -d > reader.py && echo ${b64(HOLDER)} | base64 -d > holder.py && { python3 holder.py & python3 writer.py & python3 reader.py; wait; }`,
    { cwd: '/home' }
  );
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^n=\d+ reads=True enoent=0 empty=0\n$/);
});
