import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) {
    await installDir(
      kernel,
      fileURLToPath(new URL(`${name}/`, modules)),
      `/node_modules/@ai-ecoverse/${name}`
    );
  }
  await installDir(
    kernel,
    fileURLToPath(new URL('fixtures/flocktest/', import.meta.url)),
    '/node_modules/flocktest'
  );
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp' });
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

test('a file or symlink made under a name just renamed away gets its own inode, and locks on the two stay apart (#954)', async (t) => {
  const sh = await booted(t);
  assert.deepEqual(
    await sh(
      ': > t; a=$(stat -c %i t); mv t f; : > t; f=$(stat -c %i f); n=$(stat -c %i t); [ "$a" = "$f" ] && echo kept; [ "$f" != "$n" ] && echo apart'
    ),
    ok('kept\napart\n')
  );
  assert.deepEqual(
    await sh(
      ': > s; mv s s2; ln -s x s; [ "$(stat -c %i s2)" != "$(stat -c %i s)" ] && echo apart; mkdir d; mv d d2; mkdir d; [ "$(stat -c %i d2)" != "$(stat -c %i d)" ] && echo apart'
    ),
    ok('apart\napart\n')
  );
  assert.deepEqual(
    await sh(
      ': > x; mv x x2; ( set -C; : > x ); [ "$(stat -c %i x2)" != "$(stat -c %i x)" ] && echo apart; : > y; mv y y2; mkfifo y; [ "$(stat -c %i y2)" != "$(stat -c %i y)" ] && echo apart; stat -c %F y'
    ),
    ok('apart\napart\nfifo\n')
  );
  assert.deepEqual(
    await sh(
      'flocktest open 0 rw f flock 0 ex fcntl 0 w open 1 rw t flock 1 exnb fork open 2 rw t fcntl 2 w end'
    ),
    ok('flock ok\nfcntl ok\nflock ok\nchild fcntl ok\n')
  );
});

test('a placeholder held open, unlinked and replaced by a symlink keeps the symlink after the close (#954)', async (t) => {
  const sh = await booted(t);
  assert.deepEqual(
    await sh(
      'mkdir -p p/inner && echo first > p/a.txt && cd p/inner && n=0; for i in $(seq 50); do : > link; exec 3<>link; rm link; ln -s ../a.txt link; exec 3>&-; [ "$(readlink link)" = ../a.txt ] && n=$((n + 1)); rm link; done; echo "kept=$n"'
    ),
    ok('kept=50\n')
  );
  assert.deepEqual(
    await sh(
      'cd p/inner && for i in $(seq 20); do : > l$i; exec 3<>l$i; rm l$i; ln -s ../a.txt l$i; exec 3>&-; done; sleep 1.2; n=0; for i in $(seq 20); do [ "$(readlink l$i)" = ../a.txt ] && n=$((n + 1)); done; echo "kept=$n"; ls | wc -l'
    ),
    ok('kept=20\n20\n')
  );
});

test("the atomic-save pattern, a temp file renamed over the real one again and again, never sees one file as two or the other file's bytes (#954)", async (t) => {
  const sh = await booted(t);
  assert.deepEqual(
    await sh(
      'echo 1 > g; echo 2 > g.tmp; mv g.tmp g; echo 3 > g; echo 4 > g.tmp; mv g.tmp g; echo "rc=$?"; cat g'
    ),
    ok('rc=0\n4\n')
  );
  assert.deepEqual(
    await sh(
      'n=0; for i in 1 2 3 4 5; do seq $((i * 300)) > k.tmp && mv k.tmp k && [ "$(tail -c 8 k)" = "$(seq $((i * 300)) | tail -c 8)" ] && [ "$(wc -c < k)" = "$(seq $((i * 300)) | wc -c)" ] && n=$((n + 1)); done; echo "cycles=$n"'
    ),
    ok('cycles=5\n')
  );
  assert.deepEqual(
    await sh(
      'echo old > r; mv r r2; exec 3< r2; seq 1000 > r; read -r line <&3; echo "$line"; exec 3<&-; cat r2'
    ),
    ok('old\nold\n')
  );
});

test('a reader holding the file a rename replaces keeps reading its own bytes, also on the second save (#954)', async (t) => {
  const sh = await booted(t);
  const reader = [
    "f = open('k', 'rb')",
    'f.read(10)',
    "open('r', 'w').close()",
    "exec('while not os.path.exists(\\'g\\'): time.sleep(0.02)')",
    'f.seek(3990)',
    'print(f.read(20))',
  ].join('; ');
  assert.deepEqual(
    await sh(
      `rm -f r g; head -c 4000 /dev/zero | tr '\\0' '0' > k.tmp; mv k.tmp k; python3 -c "import os, time; ${reader}" & while [ ! -e r ]; do sleep 0.05; done; head -c 6000 /dev/zero | tr '\\0' '1' > k.tmp; mv k.tmp k; : > g; wait; tail -c 4 k; echo`
    ),
    ok("b'0000000000'\n1111\n")
  );
});
