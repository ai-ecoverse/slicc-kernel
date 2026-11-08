import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

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

const FATLIKE = `
const errno = (code) => Object.assign(new Error(code), { code });
export default function () {
  const files = new Map([['/note', new TextEncoder().encode('seed')]]);
  const open = new Map();
  let fh = 0;
  return {
    capabilities: { attrTtl: 0, ranges: true },
    handlers: {
      async getattr(p) {
        if (p === '/') return { kind: 'directory', size: 0, mtime: 0, mode: 0o40755 };
        if (!files.has(p)) throw errno('ENOENT');
        return { kind: 'file', size: files.get(p).length, mtime: 0, mode: 0o100644 };
      },
      async readdir() {
        return [...files.keys()].map((p) => ({ name: p.slice(1), kind: 'file' }));
      },
      async open(p, flags) {
        if (!files.has(p)) {
          if (!flags.create) throw errno('ENOENT');
          files.set(p, new Uint8Array());
        }
        if (flags.truncate) files.set(p, new Uint8Array());
        open.set(++fh, { p, bytes: files.get(p) });
        return fh;
      },
      async read(h, o, n) { return open.get(h).bytes.slice(o, o + n); },
      async write(h, o, b) {
        const e = open.get(h);
        const next = new Uint8Array(Math.max(e.bytes.length, o + b.length));
        next.set(e.bytes);
        next.set(b, o);
        e.bytes = next;
      },
      async release(h) {
        const e = open.get(h);
        files.set(e.p, e.bytes);
        open.delete(h);
      },
      async mkdir() { throw errno('EPERM'); },
      async unlink(p) {
        if (!files.has(p)) throw errno('ENOENT');
        files.delete(p);
      },
    },
  };
}
`;

async function boot(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/fatlike/package.json',
    JSON.stringify({ slicc: { filesystems: { fatlike: { module: 'd.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/fatlike/d.mjs', FATLIKE);
  await kernel.users.add({ name: 'cone' });
  await kernel.users.add({ name: 'cone-33' });
  await kernel.run(['bash', '-c', 'mkdir -p /mnt/kb'], { cwd: '/' });
  return kernel;
}

test('a no-owners mount with uid=1000 keeps 0644/0755 by default, so another user cannot write', async (t) => {
  const kernel = await boot(t);
  const mounted = await kernel.mount({
    type: 'fatlike',
    source: 'none',
    target: '/mnt/kb',
    options: { uid: '1000', gid: '1000' },
  });
  assert.equal(mounted.state, 'ok');
  const root = await kernel.run(['bash', '-c', 'stat -c "%a %u %g" /mnt/kb /mnt/kb/note'], {
    cwd: '/',
  });
  assert.equal(root.stdout, '755 1000 1000\n644 1000 1000\n', root.stderr);
  const other = await kernel.run(
    [
      'bash',
      '-c',
      [
        'echo probe > /mnt/kb/.write-probe; echo "write $?"',
        'chmod 600 /mnt/kb/note; echo "chmod $?"',
        'stat -c %a /mnt/kb/note',
      ].join('\n'),
    ],
    { cwd: '/', user: 'cone-33' }
  );
  assert.match(other.stdout, /write 1\n/);
  assert.match(other.stdout, /chmod 1\n/);
  assert.match(other.stdout, /^644$/m);
  assert.match(other.stderr, /Permission denied|Operation not permitted/);
});

test('a no-owners mount with uid=1000,umask=000 lets another user write; fmask/dmask work the same', async (t) => {
  const kernel = await boot(t);
  for (const options of [
    { uid: '1000', gid: '1000', umask: '000' },
    { uid: '1000', gid: '1000', fmask: '000', dmask: '000' },
  ]) {
    const mounted = await kernel.mount({
      type: 'fatlike',
      source: 'none',
      target: '/mnt/kb',
      options,
    });
    assert.equal(mounted.state, 'ok');
    const modes = await kernel.run(['bash', '-c', 'stat -c "%a %u %g" /mnt/kb /mnt/kb/note'], {
      cwd: '/',
    });
    assert.equal(modes.stdout, '777 1000 1000\n666 1000 1000\n', modes.stderr);
    const other = await kernel.run(
      [
        'bash',
        '-c',
        'echo probe > /mnt/kb/.write-probe && cat /mnt/kb/.write-probe && rm /mnt/kb/.write-probe',
      ],
      { cwd: '/', user: 'cone-33' }
    );
    assert.deepEqual(other, { status: 0, stdout: 'probe\n', stderr: '' });
    await kernel.umount('/mnt/kb');
  }
});

test('tmpfs with owners ignores umask=: modes stay real and chmod still works', async (t) => {
  const kernel = await boot(t);
  const mounted = await kernel.mount({
    type: 'tmpfs',
    source: 'none',
    target: '/mnt/kb',
    options: { uid: '1000', gid: '1000', umask: '000' },
  });
  assert.equal(mounted.state, 'ok');
  const root = await kernel.run(
    [
      'bash',
      '-c',
      'stat -c %a /mnt/kb && echo x > /mnt/kb/f && chmod 640 /mnt/kb/f && stat -c %a /mnt/kb/f',
    ],
    { cwd: '/' }
  );
  assert.equal(root.stdout, '755\n640\n', root.stderr);
  const other = await kernel.run(['bash', '-c', 'echo probe > /mnt/kb/f; echo "rc $?"'], {
    cwd: '/',
    user: 'cone-33',
  });
  assert.match(other.stdout, /rc 1\n$/);
  assert.match(other.stderr, /Permission denied/);
});

test('a bad umask= value is EINVAL', async (t) => {
  const kernel = await boot(t);
  await assert.rejects(
    kernel.mount({
      type: 'fatlike',
      source: 'none',
      target: '/mnt/kb',
      options: { umask: '999' },
    }),
    (e) => e.code === 'EINVAL'
  );
});

const CHMODABLE = `
const errno = (code) => Object.assign(new Error(code), { code });
export default function () {
  const files = new Map([['/note', { bytes: new TextEncoder().encode('secret'), mode: 0o100600 }]]);
  const open = new Map();
  let fh = 0;
  return {
    capabilities: { attrTtl: 0, ranges: true, chmod: true },
    handlers: {
      async getattr(p) {
        if (p === '/') return { kind: 'directory', size: 0, mtime: 0, mode: 0o40755 };
        const f = files.get(p);
        if (!f) throw errno('ENOENT');
        return { kind: 'file', size: f.bytes.length, mtime: 0, mode: f.mode };
      },
      async readdir() {
        return [...files.keys()].map((p) => ({ name: p.slice(1), kind: 'file' }));
      },
      async open(p, flags) {
        const f = files.get(p);
        if (!f) throw errno('ENOENT');
        open.set(++fh, { p, bytes: f.bytes });
        return fh;
      },
      async read(h, o, n) { return open.get(h).bytes.slice(o, o + n); },
      async write(h, o, b) {
        const e = open.get(h);
        const next = new Uint8Array(Math.max(e.bytes.length, o + b.length));
        next.set(e.bytes);
        next.set(b, o);
        e.bytes = next;
      },
      async release(h) {
        const e = open.get(h);
        files.get(e.p).bytes = e.bytes;
        open.delete(h);
      },
      async setattr(p, change) {
        const f = files.get(p);
        if (!f) throw errno('ENOENT');
        if (change.mode !== undefined) f.mode = (f.mode & ~0o7777) | (change.mode & 0o7777);
      },
    },
  };
}
`;

test('a no-owners mount with chmod still refuses another uid chmod, so private modes stay private', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/chmodable/package.json',
    JSON.stringify({ slicc: { filesystems: { chmodable: { module: 'd.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/chmodable/d.mjs', CHMODABLE);
  await kernel.users.add({ name: 'cone' });
  await kernel.users.add({ name: 'cone-33' });
  await kernel.run(['bash', '-c', 'mkdir -p /mnt/kb'], { cwd: '/' });
  assert.equal(
    (
      await kernel.mount({
        type: 'chmodable',
        source: 'none',
        target: '/mnt/kb',
        options: { uid: '1000', gid: '1000' },
      })
    ).state,
    'ok'
  );
  const other = await kernel.run(
    [
      'bash',
      '-c',
      [
        'cat /mnt/kb/note; echo "cat $?"',
        'chmod 666 /mnt/kb/note; echo "chmod $?"',
        'stat -c %a /mnt/kb/note',
        'echo pwned > /mnt/kb/note; echo "write $?"',
        'cat /mnt/kb/note; echo "cat2 $?"',
      ].join('\n'),
    ],
    { cwd: '/', user: 'cone-33' }
  );
  assert.match(other.stdout, /cat 1\n/);
  assert.match(other.stdout, /chmod 1\n/);
  assert.match(other.stdout, /^600$/m);
  assert.match(other.stdout, /write 1\n/);
  assert.match(other.stderr, /Permission denied|Operation not permitted/);
  assert.deepEqual(await kernel.run(['bash', '-c', 'cat /mnt/kb/note'], { cwd: '/' }), {
    status: 0,
    stdout: 'secret',
    stderr: '',
  });
});
