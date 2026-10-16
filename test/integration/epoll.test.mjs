import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const fixtures = new URL('fixtures/', import.meta.url);

async function install(kernel, name, extra = []) {
  const base = fileURLToPath(new URL(`${name}/`, fixtures));
  for (const file of ['package.json', `bin/${name}.wasm`, ...extra]) {
    await kernel.writeFile(
      `/node_modules/${name}/${relative(base, join(base, file))}`,
      await readFile(join(base, file))
    );
  }
}

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await install(kernel, 'epolltest', ['bin/epolltest-28.wasm']);
  await install(kernel, 'tokiotest');
  return kernel;
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

test('a tokio program built for WASIX echoes over loopback, on the current-thread and the multi-thread runtime (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['tokiotest', 'echo']), ok('echo hello\n'));
  assert.deepEqual(await kernel.run(['tokiotest', '--multi', 'echo']), ok('echo hello\n'));
});

test('a tokio program copies stdin through a loopback socket to stdout (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['tokiotest', 'stdin'], { stdin: 'piped-in\n' }),
    ok('piped-in\n')
  );
});

test('a tokio timeout fires, never early (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['tokiotest', 'sleep', '80']), ok('timed out not early\n'));
});

test('a spawn_blocking thread wakes the tokio reactor through its eventfd waker (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['tokiotest', 'wake']), ok('woken, blocking done\n'));
  assert.deepEqual(
    await kernel.run(['tokiotest', '--multi', 'wake']),
    ok('woken, blocking done\n')
  );
});

test('a tokio writer that fills the socket resumes when the peer drains it (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['tokiotest', 'backpressure']),
    ok('sent 4194304 received 4194304\n')
  );
});

test('two tokio processes talk over loopback (#674)', async (t) => {
  const kernel = await booted(t);
  const [server, client] = await Promise.all([
    kernel.run(['tokiotest', 'serve', '4741']),
    kernel.run(['tokiotest', '--multi', 'client', '4741']),
  ]);
  assert.deepEqual(server, ok('served PING\n'));
  assert.deepEqual(client, ok('client got PING\n'));
});

test('epoll reports level-triggered registrations on every wait, edge-triggered ones once per change (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'level-edge']),
    ok(
      [
        'lt first: 1 1=IN',
        'lt again: 1 1=IN',
        'et first: 1 2=IN',
        'et again: 0',
        'et new data: 1 2=IN',
        'et after: 0',
        '',
      ].join('\n')
    )
  );
  assert.deepEqual(
    await kernel.run(['epolltest', 'et-add']),
    ok(['add ready: 1 7=IN', 'add again: 0', 'mod ready: 1 8=IN', 'mod again: 0', ''].join('\n'))
  );
});

test('a oneshot registration reports nothing, hangups included, until it is modified (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'oneshot']),
    ok(
      [
        'oneshot first: 1 3=IN',
        'oneshot disarmed: 0',
        'oneshot hangup disarmed: 0',
        'oneshot rearmed: 1 4=IN|HUP',
        'oneshot after: 0',
        '',
      ].join('\n')
    )
  );
});

test('an eventfd counts, works as a semaphore and refuses bad reads and writes (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'counter']),
    ok(
      [
        'counter read 7',
        'counter empty Resource temporarily unavailable',
        'semaphore 1 1 Resource temporarily unavailable',
        'short read Invalid argument',
        'max write Invalid argument',
        'full write Resource temporarily unavailable',
        'poll eventfd out, epoll -',
        'poll epoll after write in',
        '',
      ].join('\n')
    )
  );
});

test('a signal handler interrupts epoll_wait with EINTR, and timeouts are kept (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'eintr']),
    ok('wait -1 Interrupted system call alarms 1\n')
  );
  assert.deepEqual(
    await kernel.run(['epolltest', 'timeout']),
    ok('zero 0 prompt, timed 0 not early\nmaxevents Invalid argument\nshort waits early 0 of 200\n')
  );
});

test('epoll_ctl answers as Linux does: EEXIST, ENOENT, EINVAL, EBADF, and EPERM for files and directories, and a program on wasix-sysroot -29 or later gets WASIX epoll_ctl ADD 0, MOD 1 and DEL 2 only (#674, #684)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'errors']),
    ok(
      [
        'add ok',
        'add twice File exists',
        'mod ok',
        'mod missing No such file or directory',
        'del missing No such file or directory',
        'del ok',
        'self Invalid argument',
        'not epoll Invalid argument',
        'bad fd Bad file descriptor',
        'file Operation not permitted',
        'dir Operation not permitted',
        'op 4 Invalid argument',
        'wasix add ok',
        'wasix add twice File exists',
        'wasix mod ok',
        'wasix mod missing No such file or directory',
        'wasix del ok',
        'wasix del missing No such file or directory',
        'wasix op 3 Invalid argument',
        '',
      ].join('\n')
    )
  );
});

test('a program on wasix-sysroot -28 or older keeps the dual epoll_ctl numbering: its libc passes Linux ADD 1 untranslated, which adds, and MOD 3 modifies (#684)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest28', 'errors']),
    ok(
      [
        'add ok',
        'add twice ok',
        'mod ok',
        'mod missing No such file or directory',
        'del missing No such file or directory',
        'del ok',
        'self Invalid argument',
        'not epoll Invalid argument',
        'bad fd Bad file descriptor',
        'file Operation not permitted',
        'dir Operation not permitted',
        'op 4 Invalid argument',
        'wasix add ok',
        'wasix add twice File exists',
        'wasix mod ok',
        'wasix mod missing ok',
        'wasix del ok',
        'wasix del missing No such file or directory',
        'wasix op 3 ok',
        '',
      ].join('\n')
    )
  );
});

test('a closed descriptor leaves the interest list, and its reused number starts unregistered (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'closed']),
    ok(
      [
        'closed: 0',
        'reused same fd',
        'reused not registered: 0',
        'add reused ok',
        'reused registered: 1 10=IN',
        '',
      ].join('\n')
    )
  );
});

test('an edge-triggered writer gets EPOLLOUT again once a full pipe or socket is drained (#674)', async (t) => {
  const kernel = await booted(t);
  const rows = (kind) => [
    `${kind} ready: 1 11=OUT`,
    `${kind} filled EAGAIN`,
    `${kind} full: 0`,
    `${kind} drained: 1 11=OUT`,
  ];
  assert.deepEqual(
    await kernel.run(['epolltest', 'writable']),
    ok([...rows('pipe'), ...rows('tcp'), ''].join('\n'))
  );
});

test('epoll_wait in one thread sees a registration and an eventfd write made by another (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'ctl-wake']),
    ok('added while waiting: 1 12=IN\n')
  );
  assert.deepEqual(
    await kernel.run(['epolltest', 'cross-thread']),
    ok('woken by thread: 1 13=IN\n')
  );
});

test('a peer that shuts its write side gives EPOLLIN|EPOLLRDHUP (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'rdhup']),
    ok('open: 0\npeer shut: 1 14=IN|RDHUP\n')
  );
});

test('more ready descriptors than maxevents are reported in turn (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await kernel.run(['epolltest', 'fairness']), ok('fair all four in two waits\n'));
});

test('a nonblocking connect becomes writable and its listener readable under epoll (#674)', async (t) => {
  const kernel = await booted(t);
  const r = await kernel.run(['epolltest', 'connect']);
  assert.equal(r.status, 0, r.stderr);
  const [connect, connected, more] = r.stdout.trimEnd().split('\n');
  assert.equal(connect, 'connect Operation in progress');
  assert.deepEqual(connected.split(' ').slice(1).sort(), ['15=IN', '16=OUT', '2'].sort());
  assert.equal(more, 'connected more: 0');
});

test('epoll waits on stdin (#674)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['epolltest', 'stdin'], { stdin: 'piped-in\n' }),
    ok('stdin: 1 17=IN\nread piped-in\n')
  );
});
