import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/semtest/', import.meta.url);

async function booted(t, options = {}) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/semtest.wasm']) {
    await kernel.writeFile(`/node_modules/semtest/${file}`, await readFile(new URL(file, fixture)));
  }
  return kernel;
}

const ok = (...lines) => ({ status: 0, stdout: [...lines, ''].join('\n'), stderr: '' });
const run = (kernel, ...args) => kernel.run(['semtest', ...args], { cwd: '/' });

test('a named semaphore hands off between a parent and a forked child that opens it by name (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await run(kernel, 'handoff'), ok('create ok', 'pingpong 100 child 0'));
  assert.deepEqual(await run(kernel, 'inherit'), ok('child post ok, parent wait ok'));
});

test('a spawned child opens a named semaphore by name, and an exec drops the handles (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'spawn'),
    ok(
      'spawn ok',
      'spawned child 0, wait ok',
      'exec old handle Invalid argument',
      'exec child 0, wait ok'
    )
  );
});

test('sem_trywait and sem_getvalue (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'try'),
    ok('try Resource temporarily unavailable, value 2, try ok, value 1')
  );
});

test('a timed wait times out by either clock, never early, and an expired one is ETIMEDOUT, not EAGAIN (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'timed'),
    ok(
      'realtime: Operation timed out, not early',
      'monotonic: Operation timed out, not early',
      'past deadline, empty: Operation timed out',
      'past deadline, value 1: ok',
      'negative deadline: Invalid argument',
      'short waits early 0 of 100'
    )
  );
});

test('a timed wait stopped and continued by job control still ends at its deadline, not a full timeout later (#719)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'stopped'),
    ok('wait Operation timed out, at the deadline', 'stopped while blocked in the wait: yes')
  );
});

test('a signal handler interrupts a blocked sem_wait with EINTR (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'eintr'),
    ok('wait Interrupted system call, alarms 1, value 0')
  );
});

test('sem_wait blocks only its own thread, and waiters wake in arrival order (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'threads'),
    ok('main still runs while 3 wait, value 0', 'woken in order 1 2 3')
  );
});

test('sem_open, sem_post, sem_close and sem_unlink answer as POSIX does (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'errors'),
    ok(
      'create ok',
      'exclusive again File exists',
      'missing No such file or directory',
      "name '' Invalid argument",
      "name '/' Invalid argument",
      "name 'a/b' Invalid argument",
      "name '/.' Invalid argument",
      "name '/..' Invalid argument",
      "name '//x/y' Invalid argument",
      '251 bytes ok',
      '252 bytes Filename too long',
      'value too big Invalid argument',
      'post at max Value too large for data type, value 2147483647',
      'close unknown Invalid argument',
      'unlink missing No such file or directory'
    )
  );
});

test('an unlinked semaphore lives on for its holders, and its name can make a new one (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'unlink'),
    ok(
      'same handle yes',
      'unlink ok',
      'post after unlink ok, value 1',
      'reopen No such file or directory',
      'recreate ok, new handle, new value 5, old value 1',
      'close once ok, still open ok',
      'close twice ok, now Invalid argument'
    )
  );
});

test('with users on, a semaphore checks its mode and only its owner or root unlinks it (#717)', async (t) => {
  const kernel = await booted(t, { users: 'enforce' });
  await kernel.users.add({ name: 'cone' });
  assert.deepEqual(await run(kernel, 'owners', 'setup'), ok('private ok', 'public ok'));
  assert.deepEqual(
    await kernel.run(['semtest', 'owners', 'user'], { cwd: '/', user: 'cone' }),
    ok(
      'private Permission denied',
      'public ok',
      'unlink not owned Permission denied',
      'own ok, unlink own ok'
    )
  );
});

test('with users in report mode, a denied open is reported and goes ahead (#717)', async (t) => {
  const kernel = await booted(t, { users: 'report' });
  await kernel.users.add({ name: 'cone' });
  assert.deepEqual(await run(kernel, 'owners', 'setup'), ok('private ok', 'public ok'));
  const r = await kernel.run(['semtest', 'owners', 'user'], { cwd: '/', user: 'cone' });
  assert.equal(r.stdout.split('\n')[0], 'private ok');
});

test('a process out of semaphore handles gets EMFILE and leaves no name behind (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'handles'),
    ok(
      'opened 256, then No file descriptors available',
      'the refused name No such file or directory'
    )
  );
});

test('a killed waiter loses no posted unit, and an exiting process undoes nothing (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await run(kernel, 'killed'), ok('consumed 2, left 1, trywait took 1'));
  assert.deepEqual(await run(kernel, 'exited'), ok('value after the child took one and exited 1'));
});

test('a kernel holds at most 4096 named semaphores (#717)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await run(kernel, 'cap'),
    ok('created 4096, then No space left on device', 'after unlinking ok')
  );
});
