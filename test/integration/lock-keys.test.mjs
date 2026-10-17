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

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(lines.join('\n')).toString('base64')} | base64 -d)"`;

const HOLD_AFTER_MOVE = py([
  'import fcntl, os, time',
  "f = open('f', 'r+b')",
  "open('opened', 'w').close()",
  "while not os.path.exists('moved'):",
  '    time.sleep(0.05)',
  'fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  "print('old file locked', flush=True)",
  "open('locked', 'w').close()",
  "while not os.path.exists('go'):",
  '    time.sleep(0.05)',
]);

const TRY_NEW = py([
  'import errno, fcntl',
  "f = open('f', 'r+b')",
  'try:',
  '    fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  "    print('new file locked', flush=True)",
  'except OSError as e:',
  "    print('new file busy', errno.errorcode[e.errno], flush=True)",
]);

const UNLINKED = py([
  'import errno, fcntl, os',
  "f = open('u', 'w+b')",
  "os.unlink('u')",
  'try:',
  '    fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  '    fcntl.lockf(f, fcntl.LOCK_UN)',
  "    print('unlinked locked and unlocked', flush=True)",
  'except OSError as e:',
  "    print('unlinked', errno.errorcode[e.errno], flush=True)",
]);

const wait = (name) => `while [ ! -e ${name} ]; do sleep 0.05; done`;

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
  for (const fixture of ['flocktest', 'locktest']) {
    await installDir(
      kernel,
      fileURLToPath(new URL(`fixtures/${fixture}/`, import.meta.url)),
      `/node_modules/${fixture}`
    );
  }
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp' });
}

test('a record lock taken on a descriptor after another file was renamed over its name locks the open file, not the new one (#680)', {
  timeout: 120_000,
}, async (t) => {
  const sh = await booted(t);
  assert.deepEqual(
    await sh(
      `echo old > f; echo new > o; ${HOLD_AFTER_MOVE} & ${wait('opened')}; mv o f; touch moved; ${wait('locked')}; ${TRY_NEW}; touch go; wait`
    ),
    { status: 0, stdout: 'old file locked\nnew file locked\n', stderr: '' }
  );
});

test('a flock taken on a descriptor after another file was renamed over its name locks the open file, not the new one (#680)', {
  timeout: 120_000,
}, async (t) => {
  const sh = await booted(t);
  assert.deepEqual(
    await sh(
      'echo old > f; echo new > o; flocktest open 0 rw f touch opened await moved flock 0 ex touch locked await go & ' +
        `${wait('opened')}; mv o f; touch moved; ${wait('locked')}; flocktest open 0 rw f flock 0 exnb; touch go; wait`
    ),
    { status: 0, stdout: 'flock ok\nflock ok\n', stderr: '' }
  );
});

test('an open file that was unlinked takes and releases a record lock, as on Linux (#680)', {
  timeout: 120_000,
}, async (t) => {
  const sh = await booted(t);
  assert.deepEqual(await sh(UNLINKED), {
    status: 0,
    stdout: 'unlinked locked and unlocked\n',
    stderr: '',
  });
});

test("an Emscripten program's record lock on a descriptor whose name another file took locks the open file, and an unlinked one locks too (#680)", {
  timeout: 120_000,
}, async (t) => {
  const sh = await booted(t);
  assert.deepEqual(
    await sh(
      `echo old > f; echo new > o; locktest open f rw touch opened until moved lock w 0 0 touch locked until go > a.out & ${wait('opened')}; mv o f; touch moved; ${wait('locked')}; locktest open f rw lock w 0 0; touch go; wait; cat a.out`
    ),
    { status: 0, stdout: 'lock ok\nlock ok\n', stderr: '' }
  );
  assert.deepEqual(
    await sh(
      `rm -f opened gone; echo x > u; locktest open u rw touch opened until gone lock w 0 0 lock u 0 0 > b.out & ${wait('opened')}; rm u; touch gone; wait; cat b.out`
    ),
    { status: 0, stdout: 'lock ok\nlock ok\n', stderr: '' }
  );
});
