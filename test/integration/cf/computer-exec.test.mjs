import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  computerWith,
  nodeStorage,
  run,
  shellKernel,
  sliccBackend,
  Workspace,
} from './computer-harness.mjs';

const MOUNT = '/workspace';

describe('the slicc backend in the Workspace runtime', () => {
  let computer;
  let ws;
  before(async () => {
    computer = await computerWith({ backend: { killGraceMs: 300 } });
    ws = computer.workspace;
  });
  after(() => computer.close());

  it('is listed as a command backend', () => {
    const [info] = ws.runtime.backends();
    assert.equal(info.id, 'slicc');
    assert.equal(info.protocol, 'command');
    assert.equal(info.callable, false);
  });

  it('returns status, exit code, stdout and stderr through the runtime', async () => {
    const result = await run(ws, 'echo out; echo err >&2; exit 3');
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, 'out\n');
    assert.equal(result.stderr, 'err\n');
    assert.equal(result.pushed, 0);
    assert.equal(result.pulled, 0);
    assert.equal(result.sync.status, 'complete');
    const ok = await run(ws, 'x=$(uname); for i in 1 2 3; do echo $i; done | wc -l; echo $x');
    assert.equal(ok.status, 'completed');
    assert.equal(ok.stdout.split('\n')[0].trim(), '3');
  });

  it('passes cwd, env and stdin', async () => {
    await ws.fs.mkdir(`${MOUNT}/place`, { recursive: true });
    const result = await run(
      ws,
      'pwd; echo "$GREETING"; tr a-z A-Z; command -v cat >/dev/null && echo path',
      {
        cwd: `${MOUNT}/place`,
        env: { GREETING: 'hello there' },
        stdin: 'shout\n',
      }
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, `${MOUNT}/place\nhello there\nSHOUT\npath\n`);
    const missing = await run(ws, 'pwd', { cwd: `${MOUNT}/not-there` });
    assert.notEqual(missing.exitCode, 0);
    assert.match(missing.stderr, /not-there/);
  });

  it('hands long output to the runtime whole, past the backend log', async () => {
    const size = 6 * 1024 * 1024;
    const result = await run(ws, `head -c ${size} /dev/zero | tr "\\0" a`);
    assert.equal(result.exitCode, 0, result.stderr);
    const saved = result.truncated?.stdout;
    assert.equal(saved?.status, 'saved');
    assert.equal(saved.totalBytes, size);
    assert.equal((await ws.fs.stat(saved.path)).size, size);
  });

  it('streams output before the run exits', async () => {
    const start = performance.now();
    const handle = await ws.runtime.exec('echo one; sleep 1; echo two >&2; sleep 0.5; echo three', {
      backend: 'slicc',
      encoding: 'utf8',
    });
    const seen = [];
    for await (const event of handle) {
      seen.push({ ...event, at: performance.now() - start });
    }
    const names = seen.map((event) => event.name);
    assert.deepEqual(names, ['stdout', 'stderr', 'stdout', 'exit']);
    assert.deepEqual(
      seen.slice(0, 3).map((event) => event.value),
      ['one\n', 'two\n', 'three\n']
    );
    const [one, two, three, exit] = seen;
    assert.equal(exit.code, 0);
    assert.ok(exit.at - one.at > 1200, `one came ${exit.at - one.at} ms before exit`);
    assert.ok(three.at - two.at > 300, `two came ${three.at - two.at} ms before three`);
  });

  it('ends a sleep 100 with killExec', async () => {
    const start = performance.now();
    const handle = await ws.runtime.exec('echo started; sleep 100', {
      backend: 'slicc',
      encoding: 'utf8',
      id: 'killed-sleep',
    });
    const result = handle.result();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ws.runtime.killExec('killed-sleep', { backend: 'slicc' });
    const ended = await result;
    assert.equal(ended.status, 'cancelled');
    assert.equal(ended.exitCode, 143);
    assert.equal(ended.stdout, 'started\n');
    assert.ok(performance.now() - start < 10_000);
    await ws.runtime.killExec('killed-sleep', { backend: 'slicc' });
  });

  it('kills the process group, not only bash', async () => {
    const handle = await ws.runtime.exec(
      '(sleep 1; echo leaked > leak-a.txt) & (sleep 1; echo leaked > leak-b.txt) & wait',
      { backend: 'slicc', encoding: 'utf8', id: 'killed-group' }
    );
    const result = handle.result();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ws.runtime.killExec('killed-group', { backend: 'slicc', signal: 'SIGKILL' });
    assert.equal((await result).exitCode, 137);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await assert.rejects(ws.fs.lstat(`${MOUNT}/leak-a.txt`), { code: 'ENOENT' });
    await assert.rejects(ws.fs.lstat(`${MOUNT}/leak-b.txt`), { code: 'ENOENT' });
  });

  it('ends a run at its timeout, and escalates to SIGKILL', async () => {
    const start = performance.now();
    const timed = await run(ws, 'sleep 100', { timeoutMs: 400 });
    assert.equal(timed.status, 'cancelled');
    assert.equal(timed.exitCode, 143);
    assert.ok(performance.now() - start < 10_000);
    const stubborn = await run(ws, 'trap "" TERM; sleep 30', { timeoutMs: 300 });
    assert.equal(stubborn.exitCode, 137);
    assert.ok(performance.now() - start < 20_000);
  });

  it('re-attaches with getExec while the run is known', async () => {
    const first = await ws.runtime.exec('echo a; sleep 0.5; echo b', {
      backend: 'slicc',
      encoding: 'utf8',
      id: 'reattached',
    });
    const again = await ws.runtime.getExec('reattached', { backend: 'slicc', encoding: 'utf8' });
    const [one, two] = await Promise.all([first.result(), again.result()]);
    assert.equal(one.stdout, 'a\nb\n');
    assert.equal(two.stdout, 'a\nb\n');
    const late = await ws.runtime.getExec('reattached', { backend: 'slicc', encoding: 'utf8' });
    assert.equal((await late.result()).stdout, 'a\nb\n');
    await ws.runtime.disposeExec('reattached', { backend: 'slicc' });
    await assert.rejects(ws.runtime.getExec('reattached', { backend: 'slicc' }));
  });

  it('shows what the kernel changed to Computer change tracking', async () => {
    await ws.fs.mkdir(`${MOUNT}/tracked`, { recursive: true });
    await ws.fs.writeFile(`${MOUNT}/tracked/doomed.txt`, 'bye');
    const seen = new Map();
    const watcher = ws.provider().watch(`${MOUNT}/tracked`, { recursive: true, interval: 20 });
    watcher.on('change', (type, name) => seen.set(name, type));
    try {
      const result = await run(
        ws,
        'cd tracked && echo new > made.txt && mkdir sub && echo deep > sub/deep.txt && rm doomed.txt'
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const wanted = ['made.txt', 'sub', 'sub/deep.txt', 'doomed.txt'];
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !wanted.every((name) => seen.has(name))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(seen.get('made.txt'), 'change');
      assert.equal(seen.get('sub'), 'change');
      assert.equal(seen.get('sub/deep.txt'), 'change');
      assert.equal(seen.get('doomed.txt'), 'rename');
    } finally {
      watcher.close();
    }
  });
});

describe('reconnecting to the same kernel', () => {
  it('lets a new Workspace take the mount over, closed or not', async () => {
    const kernel = await shellKernel();
    const storage = nodeStorage();
    const open = () =>
      new Workspace({ storage, backends: [sliccBackend({ kernel: () => kernel })] });
    try {
      const first = open();
      assert.equal((await run(first, 'echo one > turns.txt; cat turns.txt')).stdout, 'one\n');
      const second = open();
      assert.equal(
        (await run(second, 'echo two >> turns.txt; cat turns.txt')).stdout,
        'one\ntwo\n'
      );
      await second.close();
      const third = open();
      assert.equal((await run(third, 'cat turns.txt')).stdout, 'one\ntwo\n');
      await third.close();
      await first.close();
      assert.deepEqual(
        (await kernel.mounts()).filter((entry) => entry.target === MOUNT),
        []
      );
    } finally {
      kernel.terminate();
      storage.close();
    }
  });
});
