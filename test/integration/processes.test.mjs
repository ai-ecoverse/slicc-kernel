import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('command substitution, a piped group and a subshell fork bash', async (t) => {
  const { page, bash } = await booted(chrome, t);

  assert.deepEqual(await bash('echo "[$(echo inner)]"'), ok('[inner]\n'));
  assert.deepEqual(await bash('echo x | { read -r y; echo "read $y"; }'), ok('read x\n'));
  assert.deepEqual(await bash('( echo sub; exit 3 ); echo "status $?"'), ok('sub\nstatus 3\n'));
  assert.deepEqual(page.errors, []);
});

test('bash spawns bash, and exit statuses make the round trip', async (t) => {
  const { bash } = await booted(chrome, t);

  assert.deepEqual(await bash('bash -c "bash -c \\"echo nested\\""'), ok('nested\n'));
  assert.deepEqual(await bash('bash -c "exit 42"; echo "child said $?"'), ok('child said 42\n'));
  assert.deepEqual(await bash('sh -c "echo \\$0"'), ok('sh\n'));
});

test('pipelines connect separate processes', async (t) => {
  const { bash } = await booted(chrome, t);

  assert.deepEqual(await bash('seq 5 | sort -rn | head -2 | tr "\\n" " "'), ok('5 4 '));
});

test('a missing command exits 127', async (t) => {
  const { bash, run } = await booted(chrome, t);

  assert.deepEqual(await bash('no-such-command'), {
    status: 127,
    stdout: '',
    stderr: 'bash: line 1: no-such-command: command not found\n',
  });
  assert.deepEqual(await run(['no-such-command']), {
    status: 127,
    stdout: '',
    stderr: 'no-such-command: command not found\n',
  });
});

test('a failing script reports its status and stderr', async (t) => {
  const { bash } = await booted(chrome, t);

  assert.deepEqual(await bash('echo partial; echo broken >&2; exit 3'), {
    status: 3,
    stdout: 'partial\n',
    stderr: 'broken\n',
  });
  assert.deepEqual(await bash('set -e; false; echo unreachable'), {
    status: 1,
    stdout: '',
    stderr: '',
  });
});

test('stdin, environment and streamed output reach the caller', async (t) => {
  const { page, run } = await booted(chrome, t);

  assert.deepEqual(
    await run(['bash', '-c', 'read -r line; echo "$GREETING $line in $PWD"'], {
      cwd: '/home/me',
      env: { GREETING: 'hello' },
      stdin: 'world\n',
    }),
    ok('hello world in /home/me\n')
  );
  const streamed = await page.evaluate(async () => {
    const chunks = [];
    const result = await window.kernel.run(['bash', '-c', 'echo one; echo two >&2'], {
      onStdout: (text) => chunks.push(`out:${text}`),
      onStderr: (text) => chunks.push(`err:${text}`),
    });
    return { chunks, status: result.status };
  });
  assert.deepEqual(streamed, { chunks: ['out:one\n', 'err:two\n'], status: 0 });
});

test('a kernel keeps the process worker it started with when the file changes in place', async (t) => {
  const { bash } = await booted(chrome, t);
  chrome.overrides.set('/dist/process-worker.js', 'throw new Error("updated in place");');
  assert.deepEqual(await bash('echo still; bash -c "echo pinned"'), ok('still\npinned\n'));
});

test('/proc lists every process of the kernel in the formats procps reads', async (t) => {
  const { page, bash } = await booted(chrome, t);
  const r = await bash(
    'sleep 100 & p=$!; ls /proc; cut -d" " -f1-4 /proc/$p/stat; cat /proc/$p/comm; head -3 /proc/self/status; cat /proc/loadavg; head -1 /proc/meminfo; head -5 /proc/stat | tail -1; kill $p; wait $p; test -e /proc/$p || echo gone',
    { cwd: '/home' }
  );
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^1000\n(?:\d+\n)*loadavg\nmeminfo\nmounts\nself\nstat\nuptime\n/);
  assert.match(
    r.stdout,
    /\n(\d+) \(sleep\) S 1000\nsleep\nName:\thead\nUmask:\t0022\nState:\tS \(sleeping\)\n/
  );
  assert.match(r.stdout, /\n0\.00 0\.00 0\.00 1\/\d+ \d+\nMemTotal: +\d+ kB\nbtime \d+\ngone\n$/);
  assert.deepEqual(page.errors, []);
});
