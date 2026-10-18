import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const FILES = 200;
const PER_FILE = 4.5;

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    await installDir(
      kernel,
      fileURLToPath(new URL(`${name}/`, modules)),
      `/node_modules/@ai-ecoverse/${name}`
    );
  }
  await installDir(
    kernel,
    fileURLToPath(new URL('fixtures/excltest/', import.meta.url)),
    '/node_modules/excltest'
  );
  const sh = async (script) => {
    const r = await kernel.run(['bash', '-c', script], { cwd: '/tmp' });
    assert.equal(r.stderr, '', script);
    return r.stdout;
  };
  return { kernel, sh };
}

test('a thread creating files asks the kernel at most 4.5 times per file, with O_CREAT|O_EXCL or O_CREAT|O_TRUNC (#1006)', async (t) => {
  const { kernel, sh } = await booted(t);
  await sh('rm -rf /tmp/xc && mkdir -p /tmp/xc/excl /tmp/xc/trunc');
  const calls = async () =>
    Number((await kernel.run(['cat', '/proc/sys/kernel/slicc_fs_calls'], { cwd: '/' })).stdout);
  const perFile = async (how) => {
    const before = await calls();
    const r = await kernel.run(['excltest', 'create', `/tmp/xc/${how}`, String(FILES), how], {
      cwd: '/',
    });
    const after = await calls();
    assert.deepEqual(r, { status: 0, stdout: `created ${FILES}\n`, stderr: '' });
    return (after - before) / FILES;
  };
  const exclusive = await perFile('excl');
  const truncating = await perFile('trunc');
  console.log(
    `kernel calls per file a thread creates: O_CREAT|O_EXCL ${exclusive.toFixed(2)}, O_CREAT|O_TRUNC ${truncating.toFixed(2)}`
  );
  for (const [how, n] of [
    ['O_CREAT|O_EXCL', exclusive],
    ['O_CREAT|O_TRUNC', truncating],
  ]) {
    assert.ok(n <= PER_FILE, `${how}: ${n.toFixed(2)} kernel calls per file, at most ${PER_FILE}`);
  }
});

test('a thread’s O_CREAT|O_EXCL on /proc/self and on a dangling symlink fails with EEXIST, as on Linux (#1006)', async (t) => {
  const { sh } = await booted(t);
  assert.equal(
    await sh(
      'rm -rf /tmp/xe && mkdir -p /tmp/xe && ln -s /tmp/xe/nowhere /tmp/xe/dangling && : > /tmp/xe/file && mkdir /tmp/xe/dir && excltest excl /proc/self /tmp/xe/dangling /tmp/xe/file /tmp/xe/dir /tmp/xe/new'
    ),
    '/proc/self EEXIST\n/tmp/xe/dangling EEXIST\n/tmp/xe/file EEXIST\n/tmp/xe/dir EEXIST\n/tmp/xe/new ok\n'
  );
  assert.equal(
    await sh('[ -L /tmp/xe/dangling ] && [ ! -e /tmp/xe/nowhere ] && echo kept'),
    'kept\n'
  );
});
