import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

for (const users of ['enforce', 'off']) {
  test(`an Emscripten program's /dev/stdin, stdout and stderr link to /proc/self/fd and stay unremovable (users: ${users})`, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
    const r = await kernel.run(
      [
        'bash',
        '-c',
        'readlink /dev/stdin /dev/stdout /dev/stderr; echo x | cat /dev/stdin; rm -f /dev/stdin; echo rc=$?; readlink /dev/stdin',
      ],
      { cwd: '/' }
    );
    assert.equal(
      r.stdout,
      '/proc/self/fd/0\n/proc/self/fd/1\n/proc/self/fd/2\nx\nrc=1\n/proc/self/fd/0\n'
    );
    assert.equal(r.stderr, "rm: cannot remove '/dev/stdin': Operation not permitted\n");
  });
}

async function devices(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasi-ripgrep', 'wasix-python']) {
    await install(kernel, name);
  }
  return kernel;
}

test('programs read /dev/zero, fail on /dev/full and stat pipes and files like Linux', async (t) => {
  const kernel = await devices(t);
  const script = [
    'printf hello > f',
    'head -c 4 /dev/zero | od -An -tx1',
    'echo hi > /dev/full; echo "builtin=$?"',
    '/bin/echo hi > /dev/full; echo "child=$?"',
    'head -c 3 < /dev/zero | od -An -tx1',
    'head -c 2 /dev/fd/3 3</dev/zero | od -An -tx1',
    '/bin/echo hi >&3 3>/dev/full; echo "inherited=$?"',
    'stat -c %F /dev/zero /dev/full',
    'echo x | stat -c %F -',
    'stat -c "%F %s" - < f',
    'stat -L -c "%F %s" /dev/fd/3 3< f',
    'wc -c < f',
    'tail -c 2 < f; echo',
  ].join('\n');
  const sh = await kernel.run(['bash', '-c', script], { cwd: '/home' });
  assert.equal(
    sh.stdout,
    [
      ' 00 00 00 00',
      'builtin=1',
      'child=1',
      ' 00 00 00',
      ' 00 00',
      'inherited=1',
      'character special file',
      'character special file',
      'fifo',
      'regular file 5',
      'regular file 5',
      '5',
      'lo',
      '',
    ].join('\n')
  );
  assert.match(sh.stderr, /No space left on device/);
  assert.equal(sh.status, 0);
  const code = [
    'import os',
    "print(open('/dev/zero', 'rb').read(3))",
    "fd = os.open('/dev/full', os.O_WRONLY)",
    "print(os.write(fd, b''))",
    'try:',
    "    os.write(fd, b'x')",
    'except OSError as e:',
    '    print(e.strerror)',
    'print(os.read(0, 2))',
  ].join('\n');
  const wasi = await kernel.run(
    [
      'bash',
      '-c',
      `python3 -c "${code}" < /dev/zero; python3 -c "print(1)" > /dev/full; echo "py=$?"`,
    ],
    { cwd: '/home' }
  );
  assert.equal(
    wasi.stdout,
    "b'\\x00\\x00\\x00'\n0\nNo space left on device\nb'\\x00\\x00'\npy=120\n"
  );
});

test('a directory redirected as stdin is handed over as a directory, as Linux does', async (t) => {
  const kernel = await devices(t);
  await kernel.writeFile('/home/d/a.txt', 'needle\n');
  const sh = await kernel.run(
    [
      'bash',
      '-c',
      'stat -c %F - < /home/d; cat < /home/d; echo "cat=$?"; cd /home/d; rg -c needle < /home/d; echo "rg=$?"; python3 -c "print(1)" < /home/d; echo "py=$?"',
    ],
    { cwd: '/home' }
  );
  assert.equal(sh.stdout, 'directory\ncat=1\na.txt:1\nrg=0\npy=1\n');
  assert.match(sh.stderr, /cat: -: Is a directory/);
  assert.match(sh.stderr, /<stdin> is a directory/);
});
