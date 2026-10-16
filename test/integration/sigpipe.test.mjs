import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('fixtures/pipetest/', import.meta.url);

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

async function booted(t, packages = []) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/pipetest.wasm']) {
    await kernel.writeFile(
      `/node_modules/pipetest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  for (const name of packages) await install(kernel, name);
  return kernel;
}

const run = (kernel, argv) => kernel.run(argv, { cwd: '/' });

test('a WASIX write to a pipe with no reader follows SIGPIPE: ignored or blocked is EPIPE, a handler runs and then EPIPE, the default ends the program (#810)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await run(kernel, ['pipetest', 'ignore']), {
    status: 0,
    stdout: 'reads back SIG_IGN\nignore: -1 Broken pipe, handled 0, not pending\n',
    stderr: '',
  });
  assert.deepEqual(await run(kernel, ['pipetest', 'handler']), {
    status: 0,
    stdout: 'handler: -1 Broken pipe, handled 1, not pending\n',
    stderr: '',
  });
  assert.deepEqual(await run(kernel, ['pipetest', 'blocked']), {
    status: 0,
    stdout: 'blocked: -1 Broken pipe, handled 0, pending\n',
    stderr: '',
  });
  assert.deepEqual(await run(kernel, ['pipetest', 'default']), {
    status: 141,
    stdout: '',
    stderr: '',
  });
});

test('a caught SIGPIPE from a write in a thread runs its handler on that thread, then the write is EPIPE (#820)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(await run(kernel, ['pipetest', 'thread']), {
    status: 0,
    stdout: 'thread: -1 Broken pipe, handled 1, on the writing thread\n',
    stderr: '',
  });
});

test('an ignored SIGPIPE survives spawn and exec: a WASIX child of bash `trap "" PIPE` gets EPIPE, unless it sets SIG_DFL itself, and so does Emscripten yes (#810)', async (t) => {
  const kernel = await booted(t, ['wasm-bash', 'wasm-coreutils']);
  const bash = (script) => run(kernel, ['bash', '-c', script]);
  assert.deepEqual(await bash(`trap '' PIPE; pipetest inherited; echo "status $?"`), {
    status: 0,
    stdout: 'inherited: -1 Broken pipe, handled 0, not pending\nstatus 0\n',
    stderr: '',
  });
  assert.deepEqual(await bash(`trap '' PIPE; exec pipetest inherited`), {
    status: 0,
    stdout: 'inherited: -1 Broken pipe, handled 0, not pending\n',
    stderr: '',
  });
  assert.deepEqual(await bash(`trap '' PIPE; pipetest dfl; echo "status $?"`), {
    status: 0,
    stdout: 'status 141\n',
    stderr: '',
  });
  assert.deepEqual(await bash(`pipetest inherited; echo "status $?"`), {
    status: 0,
    stdout: 'status 141\n',
    stderr: '',
  });
  const yes = await bash(`trap '' PIPE; yes | head -c2 >/dev/null; echo "yes \${PIPESTATUS[0]}"`);
  assert.equal(yes.stdout, 'yes 1\n');
  assert.match(yes.stderr, /^yes: standard output: Broken pipe\n$/);
  assert.deepEqual(await bash(`yes | head -c2 >/dev/null; echo "yes \${PIPESTATUS[0]}"`), {
    status: 0,
    stdout: 'yes 141\n',
    stderr: '',
  });
});

test('python, which ignores SIGPIPE, gets BrokenPipeError from os.write and print to a pipe with no reader (#810)', async (t) => {
  const kernel = await booted(t, ['wasix-python']);
  const script = [
    'import errno, os, signal',
    'print(signal.getsignal(signal.SIGPIPE) == signal.SIG_IGN)',
    'r, w = os.pipe()',
    'os.close(r)',
    'try:',
    '    os.write(w, b"x")',
    'except BrokenPipeError as e:',
    '    print("os.write", type(e).__name__, e.errno == errno.EPIPE)',
    'f = os.fdopen(w, "w")',
    'try:',
    '    print("x", file=f, flush=True)',
    'except BrokenPipeError as e:',
    '    print("print", type(e).__name__)',
    'try:',
    '    f.close()',
    'except BrokenPipeError:',
    '    pass',
  ].join('\n');
  assert.deepEqual(await run(kernel, ['python3', '-c', script]), {
    status: 0,
    stdout: 'True\nos.write BrokenPipeError True\nprint BrokenPipeError\n',
    stderr: '',
  });
});
