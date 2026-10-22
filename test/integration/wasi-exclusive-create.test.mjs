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

test('path_open honours lookupflags: without LOOKUP_SYMLINK_FOLLOW a final symlink gives ELOOP (a dangling one too, even with O_CREAT), a regular file opens, a symlinked directory earlier in the path is still followed, and O_CREAT|O_EXCL on any link gives EEXIST, as on Linux', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await installDir(
    kernel,
    fileURLToPath(new URL('fixtures/nofollowtest/', import.meta.url)),
    '/node_modules/nofollowtest'
  );
  await kernel.writeFile('/w/.keep', '');
  const r = await kernel.run(['nofollowtest'], { cwd: '/w' });
  assert.deepEqual(
    {
      status: r.status,
      stderr: r.stderr,
      lines: r.stdout
        .trim()
        .split('\n')
        .map((l) => l.replace(/ \(fd .*\)$/, '')),
    },
    {
      status: 0,
      stderr: '',
      lines: [
        'link nofollow ELOOP',
        'link follow ok',
        'file nofollow ok',
        'dirlink/file nofollow ok',
        'link excl EEXIST',
        'dangling excl EEXIST',
        'dangling nofollow creat ELOOP',
      ],
    }
  );
});

const str = (x) => [x.length, ...new TextEncoder().encode(x)];
const section = (id, body) => [id, body.length, ...body];
const CALLS_RUN = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  ...section(1, [1, 0x60, 0, 0]),
  ...section(2, [1, ...str('demo'), ...str('run'), 0, 0]),
  ...section(3, [1, 0]),
  ...section(5, [1, 0, 1]),
  ...section(7, [2, ...str('_start'), 0, 1, ...str('memory'), 2, 0]),
  ...section(10, [1, 4, 0, 0x10, 0, 0x0b]),
]);

test("an imports module's ctx.fds.open with nofollow refuses a final symlink with ELOOP, a dangling one too even with create (it never creates the link's target), and /dev/stdin and /dev/fd/N, which are links on Linux; it opens a regular file", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/demo/package.json',
    JSON.stringify({
      slicc: { abi: 'wasi', commands: { demo: { wasm: 'demo.wasm', imports: 'host.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/demo/demo.wasm', CALLS_RUN);
  await kernel.writeFile(
    '/node_modules/demo/host.mjs',
    `export function createImports(ctx) {
  return {
    demo: {
      run() {
        ctx.fs.mkdir('/w');
        ctx.fs.writeFile('/w/file', new TextEncoder().encode('x'));
        ctx.fs.symlink('file', '/w/link');
        ctx.fs.symlink('target', '/w/dangling');
        const out = [];
        const tryOpen = (label, path, o) => {
          try {
            ctx.fds.close(ctx.fds.open(path, o));
            out.push(label + ' ok');
          } catch (err) {
            out.push(label + ' ' + err.code);
          }
        };
        tryOpen('link', '/w/link', { read: true, nofollow: true });
        tryOpen('dangling', '/w/dangling', { write: true, create: true, nofollow: true });
        tryOpen('file', '/w/file', { read: true, nofollow: true });
        tryOpen('link follow', '/w/link', { read: true });
        tryOpen('stdin', '/dev/stdin', { read: true, nofollow: true });
        tryOpen('fd 1', '/dev/fd/1', { write: true, nofollow: true });
        tryOpen('fd 1 create', '/dev/fd/1', { write: true, create: true, nofollow: true });
        tryOpen('stdout follow', '/dev/stdout', { write: true });
        out.push('target ' + ctx.fs.exists('/w/target'));
        ctx.fs.writeFile('/w/out', new TextEncoder().encode(out.join('\\n')));
      },
    },
  };
}`
  );
  const r = await kernel.run(['demo'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(new TextDecoder().decode(await kernel.readFile('/w/out')).split('\n'), [
    'link ELOOP',
    'dangling ELOOP',
    'file ok',
    'link follow ok',
    'stdin ELOOP',
    'fd 1 ELOOP',
    'fd 1 create ELOOP',
    'stdout follow ok',
    'target false',
  ]);
});

test("a no-follow open racing a process that swaps the file for a symlink and back never reads the link target: the open's own hold decides", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await installDir(
    kernel,
    fileURLToPath(new URL('fixtures/nofollowtest/', import.meta.url)),
    '/node_modules/nofollowtest'
  );
  await kernel.writeFile('/w/secret', 'SECRET');
  await kernel.writeFile('/w/racy', 'plain');
  const [swapper, racer] = await Promise.all([
    kernel.run(['nofollowtest', 'swap'], { cwd: '/w' }),
    kernel.run(['nofollowtest', 'race', '8000'], { cwd: '/w' }),
  ]);
  assert.equal(swapper.status, 0, swapper.stderr);
  assert.deepEqual([racer.status, racer.stdout], [0, 'opened 1 refused 1 leaked 0\n']);
});

test('a no-follow open by a threaded program, whose files the kernel opens, racing a process that renames a symlink and a file over its name in turn never reads the link target (#1394)', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await installDir(
    kernel,
    fileURLToPath(new URL('fixtures/nofollowtest/', import.meta.url)),
    '/node_modules/nofollowtest'
  );
  await kernel.writeFile('/w/secret', 'SECRET');
  await kernel.writeFile('/w/racy', 'plain');
  const [swapper, racer] = await Promise.all([
    kernel.run(['nofollowtest', 'swap', 'over'], { cwd: '/w' }),
    kernel.run(['nofollowtest', 'threaded', 'race', '8000'], { cwd: '/w' }),
  ]);
  assert.equal(swapper.status, 0, swapper.stderr);
  assert.deepEqual([racer.status, racer.stdout], [0, 'opened 1 refused 1 leaked 0\n']);
});
