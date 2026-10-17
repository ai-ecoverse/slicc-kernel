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
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
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
  const sh = async (script) => {
    const r = await kernel.run(['bash', '-c', script], { cwd: '/tmp' });
    assert.equal(r.stderr, '', script);
    return r.stdout;
  };
  return { kernel, sh };
}

test('flock: a second open in another process is refused until the holder closes, and LOCK_EX on a read-only open excludes (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'touch f; flocktest open 0 rw f flock 0 ex touch r await g close 0 touch c await h & flocktest await r open 0 rw f flock 0 exnb flock 0 shnb touch g await c flock 0 exnb touch h; wait'
    ),
    'flock ok\nflock EAGAIN\nflock EAGAIN\nflock ok\n'
  );
  assert.equal(
    await sh(
      'rm -f r g; flocktest open 0 r f flock 0 ex touch r await g & flocktest await r open 0 r f flock 0 exnb flock 0 shnb touch g; wait'
    ),
    'flock ok\nflock EAGAIN\nflock EAGAIN\n'
  );
});

test('flock: two opens in one process conflict, shared locks coexist, and a refused upgrade keeps nothing (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'touch f; flocktest open 0 rw f open 1 rw f flock 0 ex flock 1 exnb flock 0 sh flock 1 shnb flock 0 exnb flock 1 un flock 0 exnb flock 1 shnb'
    ),
    'flock ok\nflock EAGAIN\nflock ok\nflock ok\nflock EAGAIN\nflock ok\nflock ok\nflock EAGAIN\n'
  );
});

test('flock: a dup and a forked child share the open file description, so they are granted, and the child unlocks it for both (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'touch f; flocktest open 0 rw f dup 0 1 flock 0 ex flock 1 exnb fork flock 0 exnb flock 0 un end open 2 rw f flock 2 exnb'
    ),
    'flock ok\nflock ok\nchild flock ok\nchild flock ok\nflock ok\n'
  );
  assert.equal(
    await sh('flocktest open 0 rw f flock 0 ex fork open 1 rw f flock 1 exnb end'),
    'flock ok\nchild flock EAGAIN\n'
  );
});

test('flock: exit and SIGKILL release the lock (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'touch f; flocktest open 0 rw f flock 0 ex touch r sleep 100000 & p=$!; flocktest await r; { kill -9 $p; wait $p; } 2>/dev/null; flocktest open 0 rw f flock 0 exnb'
    ),
    'flock ok\nflock ok\n'
  );
  assert.equal(
    await sh('flocktest open 0 rw f flock 0 ex; flocktest open 0 rw f flock 0 exnb'),
    'flock ok\nflock ok\n'
  );
});

test('flock: a blocking LOCK_EX waits for the holder, and a handled signal ends the wait with EINTR (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'touch f; flocktest open 0 rw f flock 0 ex touch r await g & flocktest await r open 0 rw f flock 0 ex & sleep 0.3; echo released; touch g; wait'
    ),
    'flock ok\nreleased\nflock ok\n'
  );
  assert.equal(
    await sh(
      'rm -f r g; flocktest open 0 rw f flock 0 ex touch r await g & flocktest await r trap open 0 rw f flock 0 ex & b=$!; sleep 0.3; kill -USR1 $b; wait $b; touch g; wait'
    ),
    'flock ok\nflock EINTR\n'
  );
});

test('flock: pipes, socketpairs and STDOUT lock by description, the two ends of a pipe are one object, and bad calls are EBADF or EINVAL (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'flocktest pipe 0 1 flock 1 ex fork flock 1 exnb end flock 0 exnb pair 2 3 flock 2 ex flock 3 exnb fd 4 1 flock 4 ex badfd flock 2 0 flock 2 3 flock 2 16'
    ),
    'flock ok\nchild flock ok\nflock EAGAIN\nflock ok\nflock ok\nflock ok\nbadfd EBADF\nflock EINVAL\nflock EINVAL\nflock EINVAL\n'
  );
  assert.equal(
    await sh(
      'flocktest fd 0 1 flock 0 ex touch r await g | (flocktest await r fd 0 0 flock 0 exnb; touch g; cat)'
    ),
    'flock EAGAIN\nflock ok\n'
  );
  assert.equal(
    await sh(
      'rm -f r g; flocktest fd 0 1 flock 0 ex touch r await g & flocktest await r fd 0 1 flock 0 exnb; touch g; wait'
    ),
    'flock ok\nflock ok\n'
  );
});

test('flock and fcntl locks are independent (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'touch f; flocktest open 0 rw f open 1 rw f fcntl 0 w flock 1 exnb fork fcntl 1 w flock 1 exnb end'
    ),
    'fcntl ok\nflock ok\nchild fcntl EAGAIN\nchild flock ok\n'
  );
});

test('fcntl record locks on a pipe and on a socketpair exclude a forked child (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'flocktest pipe 0 1 fcntl 1 w fork fcntl 1 w fcntl 0 r end pair 2 3 fcntl 2 w fcntl 3 w fork fcntl 2 w fcntl 3 r end'
    ),
    'fcntl ok\nchild fcntl EAGAIN\nchild fcntl EAGAIN\nfcntl ok\nfcntl ok\nchild fcntl EAGAIN\nchild fcntl EAGAIN\n'
  );
});

test('flock on a terminal: /dev/tty opened again conflicts with the inherited stdin (#893)', async (t) => {
  const { kernel } = await booted(t);
  const term = await kernel.openTerminal(
    [
      'flocktest',
      'flock',
      '0',
      'ex',
      'fork',
      'flock',
      '0',
      'exnb',
      'end',
      'open',
      '1',
      'rw',
      '/dev/tty',
      'flock',
      '1',
      'exnb',
    ],
    { cwd: '/' }
  );
  let out = '';
  term.onData = (bytes) => {
    out += new TextDecoder().decode(bytes);
  };
  assert.equal(await term.exited, 0);
  assert.equal(out, 'flock ok\r\nchild flock ok\r\nflock EAGAIN\r\n');
});

test('flock on a FIFO: two opens of it are one object and exclude each other, a dup shares (#893)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'mkfifo p; flocktest open 0 rw p open 1 rw p dup 0 2 flock 0 ex flock 2 exnb flock 1 exnb close 0 close 2 flock 1 exnb'
    ),
    'flock ok\nflock ok\nflock EAGAIN\nflock ok\n'
  );
});
