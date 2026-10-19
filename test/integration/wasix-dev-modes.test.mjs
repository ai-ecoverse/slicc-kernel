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

const NODES = [
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
  '/dev/pts/0',
  '/dev/stdin',
  '/dev/fd/0',
  '/tmp/console',
];

const PROBE = [
  'import errno, os',
  `for p in ${JSON.stringify(NODES)}:`,
  '    st = os.stat(p)',
  '    print(p, oct(st.st_mode), st.st_uid, st.st_gid)',
  "st = os.stat('/tmp/pty')",
  "print('/tmp/pty', oct(st.st_mode), st.st_uid == os.stat('/dev/pts/0').st_uid)",
  "fd = os.open('/dev/null', os.O_RDWR)",
  "print('fstat /dev/null', oct(os.fstat(fd).st_mode))",
  "print('fstat 0', oct(os.fstat(0).st_mode))",
  'try:',
  "    os.open('/dev/tty', os.O_RDWR)",
  'except OSError as e:',
  "    print('open /dev/tty', errno.errorcode[e.errno])",
].join('\n');

const py = (lines) => `python3 -c "$(echo ${Buffer.from(lines).toString('base64')} | base64 -d)"`;

const SHELL = `exec 3</dev/ptmx
rm -f /tmp/console /tmp/pty; ln -s /dev/tty /tmp/console; ln -s /dev/pts/0 /tmp/pty
for p in ${NODES.join(' ')}; do echo "$p 0o$(printf %o 0x$(stat -L -c %f $p)) $(stat -L -c '%u %g' $p)"; done
echo ---
${py(PROBE)}`;

for (const users of ['enforce', 'off']) {
  test(`a WASIX program stats the kernel's device nodes with the mode and owner an Emscripten program sees, also through a symlink (#1028, #1042, users: ${users})`, {
    timeout: 180_000,
  }, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
    await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
    const r = await kernel.run(['bash', '-c', `(${SHELL}) < /dev/null`], { cwd: '/' });
    assert.equal(r.stderr, '');
    const [emscripten, wasix] = r.stdout.split('---\n');
    const lines = wasix.split('\n');
    assert.equal(lines.slice(0, NODES.length).join('\n') + '\n', emscripten);
    assert.match(emscripten, /^\/dev\/null 0o20666 0 0\n/m);
    assert.match(emscripten, /^\/dev\/pts\/0 0o20620 /m);
    assert.match(emscripten, /^\/tmp\/console 0o20666 0 0\n/m);
    assert.deepEqual(lines.slice(NODES.length), [
      '/tmp/pty 0o20620 True',
      'fstat /dev/null 0o20666',
      'fstat 0 0o20666',
      'open /dev/tty ENXIO',
      '',
    ]);
  });
}

const ALIAS_PROBE = [
  'import os, stat',
  "for p in ['/tmp/out', '/tmp/fdlink']:",
  '    try: os.unlink(p)',
  '    except OSError: pass',
  "os.symlink('/dev/stdout', '/tmp/out')",
  "open('/tmp/f', 'w').write('12345')",
  "fd = os.open('/tmp/f', os.O_RDONLY)",
  "os.symlink('/dev/fd/%d' % fd, '/tmp/fdlink')",
  "direct, linked = os.stat('/dev/stdout'), os.stat('/tmp/out')",
  "print('stdout', stat.S_IFMT(linked.st_mode) == stat.S_IFMT(direct.st_mode), linked.st_ino == direct.st_ino)",
  "f, l = os.stat('/tmp/f'), os.stat('/tmp/fdlink')",
  "print('fd', stat.S_ISREG(l.st_mode), l.st_size, l.st_ino == f.st_ino)",
].join('\n');

test('a WASIX stat through a symlink to /dev/stdout or /dev/fd/N answers the descriptor it names, a pipe or a regular file (#1066)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  const r = await kernel.run(['bash', '-c', `${py(ALIAS_PROBE)} | cat`], { cwd: '/' });
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'stdout True True\nfd True 5 True\n');
});

const CREAT_PROBE = [
  'import errno, os',
  "for p in ['/dev/null', '/dev/zero', '/dev/stdout']:",
  "    for flags, name in ((os.O_RDWR | os.O_CREAT, 'creat'), (os.O_RDWR | os.O_CREAT | os.O_EXCL, 'excl')):",
  '        try:',
  '            os.close(os.open(p, flags))',
  "            print(p, name, 'ok')",
  '        except OSError as e:',
  '            print(p, name, errno.errorcode[e.errno])',
].join('\n');

test('O_CREAT on an existing device opens it, and O_CREAT|O_EXCL is EEXIST, in WASIX and through bash <> in Emscripten (#1104)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  const shell = `for p in /dev/null /dev/ptmx; do (exec 3<>$p) && echo "bash <> $p ok"; done; ${py(CREAT_PROBE)}`;
  const r = await kernel.run(['bash', '-c', `(${shell}) < /dev/null`], { cwd: '/' });
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    [
      'bash <> /dev/null ok',
      'bash <> /dev/ptmx ok',
      '/dev/null creat ok',
      '/dev/null excl EEXIST',
      '/dev/zero creat ok',
      '/dev/zero excl EEXIST',
      '/dev/stdout creat ok',
      '/dev/stdout excl EEXIST',
      '',
    ].join('\n')
  );
});

const WALK_PROBE = [
  'import errno, os',
  "for p in ['/tmp/through', '/tmp/dotted', '/tmp/ptsdot', '/tmp/nulled']:",
  '    try: os.unlink(p)',
  '    except OSError: pass',
  "os.symlink('/dev/missing/../tty', '/tmp/through')",
  "os.symlink('/dev/./tty', '/tmp/dotted')",
  "os.symlink('/dev/pts/../tty', '/tmp/ptsdot')",
  "os.symlink('/dev/missing/../null', '/tmp/nulled')",
  "for p in ['/tmp/through', '/tmp/dotted', '/tmp/ptsdot', '/tmp/nulled']:",
  '    try:',
  '        print(p, oct(os.stat(p).st_mode))',
  '    except OSError as e:',
  '        print(p, errno.errorcode[e.errno])',
  'try:',
  "    os.close(os.open('/tmp/nulled', os.O_RDONLY))",
  "    print('open /tmp/nulled ok')",
  'except OSError as e:',
  "    print('open /tmp/nulled', errno.errorcode[e.errno])",
].join('\n');

test('a WASIX stat through a symlink whose target passes a missing directory is ENOENT, as on Linux, while . and an existing directory still resolve to the device (#1092)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  const r = await kernel.run(['bash', '-c', `(exec 3</dev/ptmx; ${py(WALK_PROBE)}) < /dev/null`], {
    cwd: '/',
  });
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    '/tmp/through ENOENT\n/tmp/dotted 0o20666\n/tmp/ptsdot 0o20666\n/tmp/nulled ENOENT\nopen /tmp/nulled ENOENT\n'
  );
});
