import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { hostfsProxy } from './hostfs-proxy.mjs';

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

for (const ranges of [false, true]) {
  test(`sqlite3 creates, fills and reads a database on a hostfs folder ${ranges ? 'read and written in pages' : 'used whole-file'} (#1019)`, {
    timeout: 300_000,
  }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'slicc-sqlite-'));
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
    for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-sqlite3']) await install(kernel, name);
    await kernel.writeFile('/mnt/h/.keep', '');
    await kernel.mount({ type: 'hostfs', source: 'project', target: '/mnt/h' });
    const r = await kernel.run(
      [
        'bash',
        '-c',
        "sqlite3 v.db 'create table t(x); insert into t values(0); insert into t values(1);' && sqlite3 v.db 'insert into t values(2); select group_concat(x) from t;' && sqlite3 v.db 'pragma integrity_check'",
      ],
      { cwd: '/mnt/h' }
    );
    assert.deepEqual(
      { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) },
      { status: 0, stdout: '0,1,2\nok\n', stderr: '' }
    );
  });
}
