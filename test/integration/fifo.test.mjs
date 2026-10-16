import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/fifotest/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function kernelWith(t, users = 'enforce', extra = []) {
  const kernel = await createNodeKernel({ users });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', ...extra]) await install(kernel, name);
  for (const file of ['package.json', 'bin/fifotest.wasm']) {
    await kernel.writeFile(
      `/node_modules/fifotest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/home' });
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

for (const users of ['off', 'enforce']) {
  test(`mkfifo makes a FIFO that a writer and a reader in two processes meet in, users ${users} (#896)`, {
    timeout: 60_000,
  }, async (t) => {
    const bash = await kernelWith(t, users);
    assert.deepEqual(
      await bash(
        'mkfifo /tmp/f && stat -c "%F %a" /tmp/f && ls -l /tmp/f | cut -c1 && fifotest stat /tmp/f'
      ),
      ok('fifo 644\np\nfifo\n')
    );
    assert.deepEqual(
      await bash(
        'cat /tmp/f > /tmp/out & sleep 0.3; echo "reader first" > /tmp/f; wait; cat /tmp/out'
      ),
      ok('reader first\n')
    );
    assert.deepEqual(
      await bash('echo "writer first" > /tmp/f & sleep 0.3; cat /tmp/f; wait'),
      ok('writer first\n')
    );
    assert.deepEqual(
      await bash('fifotest read /tmp/f & sleep 0.3; fifotest write /tmp/f "wasix to wasix"; wait'),
      ok('wrote 14\nread: wasix to wasixread end: 0 eof\n')
    );
    assert.deepEqual(await bash('mkfifo /tmp/f; echo "rc $?"'), {
      status: 0,
      stdout: 'rc 1\n',
      stderr: "mkfifo: cannot create fifo '/tmp/f': File exists\n",
    });
    assert.deepEqual(await bash('mkfifo /dev/shm/f; echo "rc $?"'), {
      status: 0,
      stdout: 'rc 1\n',
      stderr: "mkfifo: cannot create fifo '/dev/shm/f': Operation not permitted\n",
    });
  });
}

test('a nonblocking FIFO open: a write-open with no reader is ENXIO, a read-open returns at once (#896)', {
  timeout: 60_000,
}, async (t) => {
  const bash = await kernelWith(t);
  assert.deepEqual(
    await bash('mkfifo /tmp/f; fifotest nbwrite /tmp/f; fifotest nbread /tmp/f'),
    ok('open: No such device or address\nread end: 0 eof\n')
  );
  assert.deepEqual(
    await bash('fifotest read /tmp/f & sleep 0.3; fifotest nbwrite /tmp/f nb; wait'),
    ok('wrote 2\nread: nbread end: 0 eof\n')
  );
});

test('a blocked FIFO open is EINTR after a handler, restarts with SA_RESTART, and outlives a stop (#896)', {
  timeout: 60_000,
}, async (t) => {
  const bash = await kernelWith(t);
  assert.deepEqual(
    await bash('mkfifo /tmp/f; fifotest alarm /tmp/f'),
    ok('open: Interrupted system call\n')
  );
  assert.deepEqual(
    await bash(
      'FIFOTEST_MARK=/tmp/alarmed fifotest alarm /tmp/f restart & until [ -e /tmp/alarmed ]; do sleep 0.1; done; echo late > /tmp/f; wait'
    ),
    ok('opened\nread: late\nread end: 0 eof\n')
  );
  assert.deepEqual(
    await bash(
      'fifotest read /tmp/f & pid=$!; sleep 0.3; kill -STOP $pid; sleep 0.3; kill -CONT $pid; echo resumed > /tmp/f; wait $pid; echo "rc $?"'
    ),
    ok('read: resumed\nread end: 0 eof\nrc 0\n')
  );
});

test('an open FIFO keeps working after unlink, a new mkfifo at that name is another FIFO, and /proc names the path (#896)', {
  timeout: 60_000,
}, async (t) => {
  const bash = await kernelWith(t);
  assert.deepEqual(
    await bash(
      'mkfifo /tmp/f; exec 3<>/tmp/f; readlink /proc/self/fd/3; echo kept >&3; rm /tmp/f; mkfifo /tmp/f; read -r a <&3; echo "old $a"; (echo fresh > /tmp/f &); read -r b < /tmp/f; echo "new $b"'
    ),
    ok('/tmp/f\nold kept\nnew fresh\n')
  );
});

test('make -j2 runs a recursive build through a FIFO jobserver, with no mkfifo warning (#896)', {
  timeout: 120_000,
}, async (t) => {
  const bash = await kernelWith(t, 'enforce', ['wasm-gmake']);
  const r = await bash(
    [
      'mkdir -p /tmp/m/sub && cd /tmp/m',
      'printf "all: a b\\n\\t@echo done\\na:\\n\\t@echo a\\nb:\\n\\t@\\$(MAKE) -s -C sub\\n" > Makefile',
      'printf "all:\\n\\t@echo \\"sub \\$(findstring fifo:,\\$(MAKEFLAGS))\\"\\n" > sub/Makefile',
      'make -j2 2>&1; echo "rc $?"',
    ].join('; ')
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /jobserver mkfifo|Operation not permitted/);
  assert.match(r.stdout, /^sub fifo:$/m);
  assert.match(r.stdout, /^a$/m);
  assert.match(r.stdout, /done\nrc 0\n$/);
});
