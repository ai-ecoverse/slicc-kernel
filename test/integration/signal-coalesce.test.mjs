import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name, skip) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    const rel = relative(base, file);
    if (skip?.test(rel)) continue;
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${rel}`, await readFile(file));
  }
}

const hog = (kernel) =>
  kernel.run(['bash', '-c', 'end=$((SECONDS+40)); while [ $SECONDS -lt $end ]; do :; done']);

const py = (src) => `python3 -c "$(echo ${Buffer.from(src).toString('base64')} | base64 -d)"`;

const CAUGHT = [
  'import os, signal',
  'hits = []',
  'signal.signal(signal.SIGUSR1, lambda s, f: hits.append(s))',
  'signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR1})',
  "open('/tmp/ready', 'w').close()",
  "while not os.path.exists('/tmp/sent'): pass",
  'signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGUSR1})',
  'for i in range(3): os.getpid()',
  "os.write(1, ('runs %d\\n' % len(hits)).encode())",
].join('\n');

const SPINNING = [
  'import os, signal',
  'hits = []',
  'signal.signal(signal.SIGUSR1, lambda s, f: hits.append(s))',
  "open('/tmp/ready.tmp', 'w').close()",
  "os.rename('/tmp/ready.tmp', '/tmp/ready')",
  'n = 0',
  'for i in range(40000000): n += i',
  'for i in range(3): os.getpid()',
  "os.write(1, ('runs %d\\n' % len(hits)).encode())",
].join('\n');

const UNCAUGHT = [
  "open('/tmp/ready', 'w').close()",
  'n = 0',
  'for i in range(20000000): n += i',
  "print('survived')",
].join('\n');

const sender = (src) =>
  `rm -f /tmp/ready /tmp/sent; ${py(src)} & until [ -e /tmp/ready ]; do :; done; kill -USR1 $!; kill -USR1 $!; touch /tmp/sent; wait $!; echo "status $?"`;

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  return kernel;
}

test('two SIGUSR1s sent while the program blocks it are both pending at once; unblocked, the handler runs once and the program lives (#1088)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await booted(t);
  const r = await kernel.run(['bash', '-c', sender(CAUGHT)], { cwd: '/' });
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'runs 1\nstatus 0\n');
});

test('a second SIGUSR1 sent while the first is still pending at a program spinning without kernel calls coalesces too: one handler run, and the program lives (#1088)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await booted(t);
  const r = await kernel.run(['bash', '-c', sender(SPINNING)], { cwd: '/' });
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'runs 1\nstatus 0\n');
});

test('an uncaught pending SIGUSR1 still ends the program, as before (#1088)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await booted(t);
  const r = await kernel.run(['bash', '-c', sender(UNCAUGHT)], { cwd: '/' });
  assert.equal(r.stdout, 'status 138\n');
});

test('a 2 ms SIGALRM timer under CPU hogs never ends the umask-alarm program with 142 (#1088)', {
  timeout: 300_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  const fixture = new URL('fixtures/umaskalarm/', import.meta.url);
  for (const file of ['package.json', 'bin/umaskalarm.wasm']) {
    await kernel.writeFile(
      `/node_modules/umaskalarm/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  await kernel.writeFile('/tmp/ua/.keep', '');
  const hogs = Array.from({ length: 12 }, () => hog(kernel));
  const statuses = [];
  for (let i = 0; i < 10; i++)
    statuses.push((await kernel.run(['umaskalarm', '/tmp/ua'], { cwd: '/' })).status);
  await Promise.all(hogs);
  assert.deepEqual(statuses, Array(10).fill(0));
});

async function terminal(kernel, script) {
  const term = await kernel.openTerminal(['bash', '-c', `rm -f /tmp/ready; ${py(script)}`], {
    cwd: '/',
  });
  let screen = '';
  term.onData = (bytes) => {
    screen += new TextDecoder().decode(bytes);
  };
  const ready = () =>
    kernel.readFile('/tmp/ready').then(
      () => true,
      () => false
    );
  while (!(await ready())) await new Promise((r) => setTimeout(r, 20));
  return { term, screen: () => screen };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('a repeated ^C ends a WASI program that computes without making kernel calls, as its caught SIGINT can never run there (#1088)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await booted(t);
  const script = [
    'import os, signal',
    "signal.signal(signal.SIGINT, lambda s, f: os.write(1, b'handled\\n'))",
    "open('/tmp/ready', 'w').close()",
    'while True: pass',
  ].join('\n');
  const { term, screen } = await terminal(kernel, script);
  const ended = term.exited.then((s) => ({ s }));
  term.write('\x03');
  assert.equal(await Promise.race([ended, settle(1500).then(() => 'running')]), 'running');
  let sent = 1;
  let result = 'running';
  while (result === 'running' && sent < 4) {
    term.write('\x03');
    sent += 1;
    result = await Promise.race([ended, settle(3000).then(() => 'running')]);
  }
  assert.notEqual(result, 'running', screen());
  assert.equal(result.s, 130);
});

test('a SIGINT held while its own handler runs, then sent again, gives one more handler run, not a kill (#1088)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await booted(t);
  const script = [
    'import os, signal, time',
    'runs = []',
    'def h(s, f):',
    '    runs.append(s)',
    '    if len(runs) == 1:',
    "        open('/tmp/inhandler', 'w').close()",
    '        time.sleep(1)',
    'signal.signal(signal.SIGINT, h)',
    "open('/tmp/ready', 'w').close()",
    'while len(runs) < 2: time.sleep(0.01)',
    "print('runs', len(runs), flush=True)",
  ].join('\n');
  await kernel.run(['bash', '-c', 'rm -f /tmp/inhandler'], { cwd: '/' });
  const { term, screen } = await terminal(kernel, script);
  term.write('\x03');
  while (
    !(await kernel.readFile('/tmp/inhandler').then(
      () => true,
      () => false
    ))
  )
    await settle(20);
  term.write('\x03');
  const status = await Promise.race([term.exited, settle(30_000).then(() => 'still running')]);
  assert.equal(status, 0, screen());
  assert.match(screen(), /runs 2/);
});
