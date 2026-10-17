import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/fdalias/', import.meta.url);

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

async function kernelWith(t, users) {
  const kernel = await createNodeKernel({ users });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  for (const file of ['package.json', 'bin/fdalias.wasm']) {
    await kernel.writeFile(`/node_modules/fdalias/${file}`, await readFile(new URL(file, fixture)));
  }
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/home' });
  return { kernel, bash };
}

for (const users of ['off', 'enforce']) {
  test(`a WASIX stat of /dev/stdin and /proc/self/fd/N describes the fd's object, users ${users} (#894)`, {
    timeout: 60_000,
  }, async (t) => {
    const { bash } = await kernelWith(t, users);
    assert.deepEqual(
      await bash('echo x | fdalias /dev/stdin /proc/self/fd/0 /dev/fd/0 /proc/self/fd/50'),
      {
        status: 0,
        stdout: [
          '/dev/stdin: stat fifo, lstat lnk, link /proc/self/fd/0',
          '/proc/self/fd/0: stat fifo, lstat lnk, link pipe:[',
          '/dev/fd/0: stat fifo, lstat lnk, link pipe:[',
          '/proc/self/fd/50: stat No such file or directory, lstat No such file or directory, link No such file or directory',
          '',
        ].join('\n'),
        stderr: '',
      }
    );
    assert.deepEqual(
      await bash(
        'echo hi > /tmp/f; fdalias /dev/stdin /proc/self/fd/0 < /tmp/f; fdalias cat /proc/self/fd/0 < /tmp/f; echo piped | fdalias cat /proc/self/fd/0; fdalias /dev/stdin < /dev/null'
      ),
      {
        status: 0,
        stdout: [
          '/dev/stdin: stat reg, lstat lnk, link /proc/self/fd/0',
          '/proc/self/fd/0: stat reg, lstat lnk, link /tmp/f',
          'read /proc/self/fd/0: hi',
          'read /proc/self/fd/0: piped',
          '/dev/stdin: stat chr, lstat lnk, link /proc/self/fd/0',
          '',
        ].join('\n'),
        stderr: '',
      }
    );
  });
}

for (const users of ['off', 'enforce']) {
  test(`a WASIX program's own open of a FIFO reads back as its path through /proc/self/fd/N, a pipe as pipe:[ino], users ${users} (#909)`, {
    timeout: 60_000,
  }, async (t) => {
    const { bash } = await kernelWith(t, users);
    assert.deepEqual(
      await bash('mkfifo /tmp/f; fdalias open /tmp/f; echo x | fdalias /proc/self/fd/0'),
      {
        status: 0,
        stdout: 'opened /tmp/f: link /tmp/f\n/proc/self/fd/0: stat fifo, lstat lnk, link pipe:[\n',
        stderr: '',
      }
    );
  });
}

test('on a terminal, /dev/stdin and /proc/self/fd/0 stat as a character device (#894)', {
  timeout: 60_000,
}, async (t) => {
  const { kernel } = await kernelWith(t, 'enforce');
  const term = await kernel.openTerminal(['fdalias', '/dev/stdin', '/proc/self/fd/0'], {
    cwd: '/',
  });
  let out = '';
  term.onData = (bytes) => {
    out += new TextDecoder().decode(bytes);
  };
  assert.equal(await term.exited, 0);
  assert.equal(
    out,
    '/dev/stdin: stat chr, lstat lnk, link /proc/self/fd/0\r\n/proc/self/fd/0: stat chr, lstat lnk, link /dev/tty\r\n'
  );
});
