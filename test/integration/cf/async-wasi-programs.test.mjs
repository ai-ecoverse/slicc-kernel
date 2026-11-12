import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  both,
  installFixture,
  installPackage,
  kernelPair,
  shown,
  skip,
  terminal,
} from './async-wasi-harness.mjs';

const tree = async (kernel) => {
  await installPackage(kernel, 'wasi-ripgrep');
  await installPackage(kernel, 'wasix-python');
  for (let d = 0; d < 5; d++) {
    for (let f = 0; f < 20; f++) {
      const body = f % 7 === 0 ? `line\nneedle ${d}-${f}\n` : `nothing here ${d} ${f}\n`;
      await kernel.writeFile(`/work/d${d}/f${f}.txt`, body);
    }
  }
};

const same = async (pair, argv, options) => {
  const { sync, async } = await both(pair, argv, { cwd: '/work', ...options });
  assert.deepEqual(shown(async), shown(sync));
  return shown(sync);
};

test('rg over a tree of files gives the same status, stdout and stderr on the async host', {
  skip,
}, async (t) => {
  const pair = await kernelPair(t, tree);
  const found = await same(pair, ['rg', '--sort', 'path', '-n', 'needle', '/work']);
  assert.equal(found.status, 0);
  assert.equal(found.stdout.split('\n').filter(Boolean).length, 15);
  assert.equal((await same(pair, ['rg', 'absent-word', '/work'])).status, 1);
  assert.equal((await same(pair, ['rg', '(unclosed', '/work'])).status, 2);
  await same(pair, ['rg', '--files', '--sort', 'path', '/work/d1']);
  await same(pair, ['rg', '-c', 'needle', '/no/such/dir']);
});

test('exit codes, stdin and a pipeline between two WASI programs match the sync kernel', {
  skip,
}, async (t) => {
  const pair = await kernelPair(t, tree);
  assert.equal((await same(pair, ['python', '-c', 'raise SystemExit(7)'])).status, 7);
  assert.equal(
    (await same(pair, ['python', '-c', 'import sys; sys.stderr.write("e\\n"); sys.exit(3)']))
      .status,
    3
  );
  const upper = await same(
    pair,
    ['python', '-c', 'import sys; print(sys.stdin.read().upper(), end="")'],
    {
      stdin: 'from stdin\nsecond line\n',
    }
  );
  assert.equal(upper.stdout, 'FROM STDIN\nSECOND LINE\n');
  const piped = await same(pair, [
    'python',
    '-c',
    [
      'import subprocess as s',
      'p = s.Popen(["rg", "--sort", "path", "needle", "/work"], stdout=s.PIPE)',
      'q = s.run(["rg", "-c", "needle"], stdin=p.stdout, capture_output=True)',
      'p.stdout.close()',
      'print(p.wait(), q.returncode, q.stdout.decode().strip())',
    ].join('\n'),
  ]);
  assert.equal(piped.stdout, '0 0 15\n');
});

test('a WASIX fork through Asyncify: python os.fork and the forktls and piefork fixtures', {
  skip,
}, async (t) => {
  const pair = await kernelPair(t, async (kernel) => {
    await tree(kernel);
    for (const name of ['forktls', 'piefork']) await installFixture(kernel, name);
  });
  const forked = await same(
    pair,
    [
      'python',
      '-c',
      'import os\npid = os.fork()\nif pid == 0:\n  print("child", flush=True)\n  os._exit(5)\nprint("parent", os.waitpid(pid, 0)[1] >> 8)',
    ],
    { env: { PYTHON_FORK: 'true' } }
  );
  assert.equal(forked.stdout, 'child\nparent 5\n');
  assert.equal((await same(pair, ['piefork'])).status, 0);
  assert.equal((await same(pair, ['forktls-pie'])).status, 0);
  assert.equal((await same(pair, ['forktls-static'])).status, 0);
});

for (const signal of ['SIGINT', 'SIGKILL']) {
  test(`${signal} ends a WASI program blocked in a read on the async host as it does on the sync kernel`, {
    skip,
  }, async (t) => {
    const pair = await kernelPair(t, tree);
    const ends = {};
    for (const mode of ['sync', 'async']) {
      const run = await terminal(pair[mode], [
        'python',
        '-c',
        'import sys\nprint("waiting", flush=True)\ntry:\n  sys.stdin.readline()\nexcept KeyboardInterrupt:\n  print("interrupted", flush=True)\n  raise SystemExit(9)',
      ]);
      await run.until('waiting');
      await new Promise((resolve) => setTimeout(resolve, 100));
      run.term.signal(signal);
      ends[mode] = { ended: await run.ended(), interrupted: run.text().includes('interrupted') };
    }
    assert.deepEqual(ends.async, ends.sync);
    assert.deepEqual(
      ends.sync,
      signal === 'SIGINT'
        ? { ended: { status: 9 }, interrupted: true }
        : { ended: { status: 137, signal: 'SIGKILL' }, interrupted: false }
    );
  });
}

test('a blocking read wakes when its writer writes, on the async host', { skip }, async (t) => {
  const pair = await kernelPair(t, tree);
  for (const mode of ['sync', 'async']) {
    const run = await terminal(pair[mode], [
      'python',
      '-c',
      'import sys\nprint("ready", flush=True)\nline = sys.stdin.readline()\nprint("got", line.strip().upper(), flush=True)',
    ]);
    await run.until('ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
    run.term.write('late input\r');
    await run.until('got LATE INPUT');
    assert.deepEqual(await run.ended(), { status: 0 }, mode);
  }
});
