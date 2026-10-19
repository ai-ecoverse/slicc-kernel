import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { setTestSyscallHook } from '../../dist/testing.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const enc = (t) => new TextEncoder().encode(t);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

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

test('a ^C while interactive bash forks a job, before the child has set up its process group, leaves bash with the terminal: it reads its next line (homescoop#1230)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  let out = '';
  const d = new TextDecoder();
  const term = await kernel.openTerminal(['bash', '--norc', '-i'], {
    cwd: '/',
    onData: (b) => (out += d.decode(b, { stream: true })),
  });
  let exited = null;
  term.exited.then((code) => (exited = code));
  for (let i = 0; i < 1000 && !/[$#] /.test(out); i++) await settle(10);
  let shell;
  let child;
  t.after(() => setTestSyscallHook(undefined));
  setTestSyscallHook(async ({ pid, op }) => {
    if (op === 'proc-fork' && shell === undefined) {
      shell = pid;
      term.write(enc('\x03'));
    } else if (
      shell !== undefined &&
      pid !== shell &&
      child === undefined &&
      op === 'proc-setpgid'
    ) {
      child = pid;
      await settle(300);
    }
  });
  term.write(enc('sleep 0.1 && echo ran\r'));
  for (let i = 0; i < 1000 && child === undefined; i++) await settle(10);
  await settle(800);
  setTestSyscallHook(undefined);
  term.write(enc('echo "after"\r'));
  for (let i = 0; i < 1000 && !/[^"]after\r\n/.test(out) && exited === null; i++) await settle(10);
  assert.deepEqual(
    [child !== undefined, exited, /[^"]after\r\n/.test(out)],
    [true, null, true],
    out
  );
  term.close();
  await Promise.race([term.exited.catch(() => undefined), settle(5000)]);
});
