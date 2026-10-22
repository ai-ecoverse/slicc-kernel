import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name, skip) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    const rel = relative(fileURLToPath(base), file);
    if (skip?.test(rel)) continue;
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${rel}`, await readFile(file));
  }
}

test('a descriptor keeps writing to its file after a rename over its name fails (#1394, #1410 review)', {
  timeout: 600_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  const script = [
    'import os',
    'os.makedirs("/tmp/fr/dir", exist_ok=True)',
    'open("/tmp/fr/f", "w").write("old")',
    'fd = os.open("/tmp/fr/f", os.O_RDWR)',
    'os.lseek(fd, 0, os.SEEK_END)',
    'for src in ("/tmp/fr/missing", "/tmp/fr/dir"):',
    '    try:',
    '        os.rename(src, "/tmp/fr/f")',
    '    except OSError as e:',
    '        print("refused", e.errno)',
    'os.write(fd, b"+new")',
    'os.fsync(fd)',
    'os.close(fd)',
    'print(open("/tmp/fr/f").read())',
  ].join('\n');
  const r = await kernel.run(['python3', '-c', script], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').at(-1), 'old+new', r.stdout);
});

const fixture = new URL('./fixtures/ebindtest/', import.meta.url);

test("an Emscripten program's open file stays bound to it when the program renames another file over its name, also on tmpfs and between two links of one file (#1394, #1410 review)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/ebindtest/package.json',
    await readFile(new URL('package.json', fixture))
  );
  for (const file of ['bin/ebindtest', 'bin/ebindtest.wasm']) {
    await kernel.writeFile(
      `/node_modules/ebindtest/${file}`,
      await readFile(new URL(file, fixture)),
      { mode: 0o755 }
    );
  }
  await kernel.run(['mkdir', '-p', '/mnt/t'], { cwd: '/' });
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  const r = await kernel.run(
    [
      'bash',
      '-c',
      [
        'for d in /tmp/eb /mnt/t; do',
        '  mkdir -p $d && cd $d && printf old > held && printf NEW-BYTES > other && rm -f twin',
        '  ebindtest held other twin; cat held; echo',
        'done',
      ].join('\n'),
    ],
    { cwd: '/' }
  );
  assert.deepEqual(r, {
    status: 0,
    stdout: 'old old+w same\nNEW-BYTES\nold old+w same\nNEW-BYTES\n',
    stderr: '',
  });
});
