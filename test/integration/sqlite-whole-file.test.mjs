import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';
import { hostfsProxy } from './hostfs-proxy.mjs';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const locktest = new URL('./fixtures/locktest/', import.meta.url);

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

async function installLocktest(kernel) {
  for (const file of ['package.json', 'bin/locktest', 'bin/locktest.wasm']) {
    await kernel.writeFile(
      `/node_modules/locktest/${file}`,
      await readFile(new URL(file, locktest))
    );
  }
}

function ownRoot() {
  const root = memoryRoot();
  return new Proxy(root, {
    get: (target, key) => {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    getPrototypeOf: () => Object.prototype,
  });
}

async function hostfsKernel(t, ranges) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-whole-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const proxy = await hostfsProxy({
    folders: { project: dir },
    pingMs: 100,
    capabilities: { ranges },
  });
  t.after(() => proxy.close());
  const kernel = await createNodeKernel({
    hostfs: async (source, { readonly }) => proxy.grant(source, readonly),
  });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/mnt/h/.keep', '');
  await kernel.mount({ type: 'hostfs', source: 'project', target: '/mnt/h' });
  return { kernel, cwd: '/mnt/h' };
}

async function ownRootKernel(t) {
  const kernel = await createNodeKernel({ root: ownRoot() });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/w/.keep', '');
  return { kernel, cwd: '/w' };
}

const ROOTS = {
  'a Node kernel on its own root': ownRootKernel,
  'a hostfs folder used whole-file': (t) => hostfsKernel(t, false),
  'a hostfs folder read and written in pages': (t) => hostfsKernel(t, true),
};

const run = async ({ kernel, cwd }, script) => {
  const r = await kernel.run(['bash', '-c', script], { cwd });
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
};

for (const [where, start] of Object.entries(ROOTS)) {
  test(`on ${where}, sqlite3 creates, fills and checks a database (#1019)`, {
    timeout: 300_000,
  }, async (t) => {
    const k = await start(t);
    for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-sqlite3'])
      await install(k.kernel, name);
    assert.deepEqual(
      await run(
        k,
        "sqlite3 v.db 'create table t(x); insert into t values(0); insert into t values(1);' && sqlite3 v.db 'insert into t values(2); select group_concat(x) from t;' && sqlite3 v.db 'pragma integrity_check'"
      ),
      { status: 0, stdout: '0,1,2\nok\n', stderr: '' }
    );
  });

  test(`on ${where}, a program that locks a file and then writes it sees the size it wrote (#1019)`, {
    timeout: 300_000,
  }, async (t) => {
    const k = await start(t);
    for (const name of ['wasm-bash', 'wasm-coreutils']) await install(k.kernel, name);
    await installLocktest(k.kernel);
    assert.deepEqual(
      await run(
        k,
        'printf abc > c && for i in 1 2 3; do locktest open c rw lock w 0 0 size append x size append yy size close; done; cat c; echo'
      ),
      {
        status: 0,
        stdout: [
          'lock ok\nsize 3\nappend 3 1\nsize 4\nappend 4 2\nsize 6\n',
          'lock ok\nsize 6\nappend 6 1\nsize 7\nappend 7 2\nsize 9\n',
          'lock ok\nsize 9\nappend 9 1\nsize 10\nappend 10 2\nsize 12\n',
          'abcxyyxyyxyy\n',
        ].join(''),
        stderr: '',
      }
    );
  });
}
