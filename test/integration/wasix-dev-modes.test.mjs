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
];

const PROBE = [
  'import errno, os',
  `for p in ${JSON.stringify(NODES)}:`,
  '    st = os.stat(p)',
  '    print(p, oct(st.st_mode), st.st_uid, st.st_gid)',
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
for p in ${NODES.join(' ')}; do echo "$p 0o$(printf %o 0x$(stat -L -c %f $p)) $(stat -L -c '%u %g' $p)"; done
echo ---
${py(PROBE)}`;

for (const users of ['enforce', 'off']) {
  test(`a WASIX program stats the kernel's device nodes with the mode and owner an Emscripten program sees (#1028, users: ${users})`, {
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
    assert.deepEqual(lines.slice(NODES.length), [
      'fstat /dev/null 0o20666',
      'fstat 0 0o20666',
      'open /dev/tty ENXIO',
      '',
    ]);
  });
}
