import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestSyscallHook } from '../../../dist/testing.js';
import {
  WAIT_MS as FIXTURE_MS,
  installTimedwaits,
  parsed,
  ROUNDS,
} from './async-waits/timedwaits.mjs';
import { installPackage, kernelPair, shown, skip } from './async-wasi-harness.mjs';

const WAIT_MS = 300;
const SLICE_MS = 50;

const cases = {
  'sigtimedwait with nothing pending': `import signal, time
signal.pthread_sigmask(signal.SIG_BLOCK, [signal.SIGUSR1])
t = time.monotonic()
print(signal.sigtimedwait([signal.SIGUSR1], ${WAIT_MS / 1000}), time.monotonic() - t >= ${WAIT_MS / 1000})`,
  'a futex wait with a timeout (Lock.acquire)': `import threading, time
l = threading.Lock()
l.acquire()
t = time.monotonic()
print(l.acquire(timeout=${WAIT_MS / 1000}), time.monotonic() - t >= ${WAIT_MS / 1000})`,
  'a futex wait with a timeout (Event.wait)': `import threading, time
e = threading.Event()
t = time.monotonic()
print(e.wait(${WAIT_MS / 1000}), time.monotonic() - t >= ${WAIT_MS / 1000})`,
};

const sender = (sig) =>
  `subprocess.Popen(["python", "-c", "import os, sys, time; time.sleep(0.1); os.kill(int(sys.argv[1]), ${sig})", str(os.getpid())])`;

const woken = {
  'sigtimedwait ends when another process sends the signal': `import os, signal, subprocess, time
signal.pthread_sigmask(signal.SIG_BLOCK, [signal.SIGUSR1])
t = time.monotonic()
${sender(10)}
info = signal.sigtimedwait([signal.SIGUSR1], 5)
print(info.si_signo, time.monotonic() - t < 2)`,
};

function counting(t) {
  const seen = { selects: 0 };
  setTestSyscallHook(({ op }) => {
    if (op === 'fd-select') seen.selects++;
  });
  t.after(() => setTestSyscallHook(undefined));
  return seen;
}

test('timed waits on the async host wait in the kernel, never on a local timer, and end as on the sync kernel', {
  skip,
}, async (t) => {
  const pair = await kernelPair(t, (kernel) => installPackage(kernel, 'wasix-python'));
  const seen = counting(t);
  for (const [name, code] of Object.entries(cases)) {
    seen.selects = 0;
    const sync = shown(await pair.sync.run(['python', '-c', code], { cwd: '/' }));
    const before = seen.selects;
    const async = shown(await pair.async.run(['python', '-c', code], { cwd: '/' }));
    assert.deepEqual(async, sync, name);
    assert.equal(sync.status, 0, name);
    assert.match(sync.stdout, / True\n$/, name);
    assert.equal(before, 0, `${name}: the sync kernel waits locally`);
    assert.ok(seen.selects >= WAIT_MS / SLICE_MS / 2, `${name}: ${seen.selects} kernel waits`);
  }
});

test('a timed wait on the async host still ends at once for a signal from another process', {
  skip,
}, async (t) => {
  const pair = await kernelPair(t, (kernel) => installPackage(kernel, 'wasix-python'));
  for (const [name, code] of Object.entries(woken)) {
    const sync = shown(await pair.sync.run(['python', '-c', code], { cwd: '/' }));
    const async = shown(await pair.async.run(['python', '-c', code], { cwd: '/' }));
    assert.deepEqual(async, sync, name);
    assert.equal(sync.stdout, '10 True\n', name);
  }
});

test('a WASIX futex_wait and a slicc.sigwait with a timeout take their time on the async host, through the kernel', {
  skip,
}, async (t) => {
  const pair = await kernelPair(t, (kernel) =>
    installTimedwaits((path, data) => kernel.writeFile(path, data))
  );
  const seen = counting(t);
  const runs = {};
  for (const mode of ['sync', 'async']) {
    seen.selects = 0;
    const r = await pair[mode].run(['timedwaits'], { cwd: '/' });
    assert.deepEqual({ status: r.status, stderr: r.stderr }, { status: 0, stderr: '' }, mode);
    runs[mode] = { lines: parsed(r.stdout), selects: seen.selects };
  }
  const shape = (lines) => lines.map(({ kind, errno, extra }) => [kind, errno, extra]);
  assert.deepEqual(shape(runs.async.lines), shape(runs.sync.lines));
  assert.deepEqual(
    shape(runs.async.lines),
    Array.from({ length: ROUNDS }, () => [
      ['futex', 0, 0],
      ['sigwait', 6, 0],
    ]).flat()
  );
  for (const { kind, ms } of runs.async.lines) assert.ok(ms >= FIXTURE_MS, `${kind} took ${ms} ms`);
  assert.equal(runs.sync.selects, 0);
  assert.ok(runs.async.selects >= (ROUNDS * FIXTURE_MS) / SLICE_MS, `${runs.async.selects}`);
});
