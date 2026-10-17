import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const BIN = '/node_modules/@ai-ecoverse/wasm-coreutils/bin';

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

async function boot(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const sh = (script, user) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
  return { kernel, sh };
}

test("a byte-identical copy of a package's glue, next to it and named for one of its commands, runs as that command by path (#899)", async (t) => {
  const { sh } = await boot(t);
  await sh(`cp ${BIN}/coreutils ${BIN}/basename && chmod 755 ${BIN}/basename`);
  assert.deepEqual(await sh(`${BIN}/basename /a/b/c.txt .txt; echo rc=$?`), {
    status: 0,
    stdout: 'c\nrc=0\n',
    stderr: '',
  });
  assert.deepEqual(
    await sh(`cd ${BIN} && ./basename /x/y; ln -s ${BIN}/basename /tmp/bn && /tmp/bn /p/q`),
    {
      status: 0,
      stdout: 'y\nq\n',
      stderr: '',
    }
  );
  assert.deepEqual(await sh(`${BIN}/basename /u/v`, 'cone'), {
    status: 0,
    stdout: 'v\n',
    stderr: '',
  });
});

test('a copy in another directory, a same-named file that differs, or one the caller cannot read does not run as the command (#899)', async (t) => {
  const { sh } = await boot(t);
  const notRun =
    /cannot execute|Exec format error|not found|Permission denied|syntax error|unexpected/;
  await sh(`mkdir -p /tmp/x && cp ${BIN}/coreutils /tmp/x/basename && chmod 755 /tmp/x/basename`);
  const elsewhere = await sh('/tmp/x/basename /a/b');
  assert.notEqual(elsewhere.stdout, 'b\n');
  assert.notEqual(elsewhere.status, 0);
  await sh(
    `cp ${BIN}/coreutils ${BIN}/dirname && printf '\\n' >> ${BIN}/dirname && chmod 755 ${BIN}/dirname`
  );
  const differs = await sh(`${BIN}/dirname /a/b`);
  assert.notEqual(differs.stdout, '/a\n');
  assert.notEqual(differs.status, 0);
  await sh(`cp ${BIN}/coreutils ${BIN}/basename && chmod 711 ${BIN}/basename`);
  const unread = await sh(`${BIN}/basename /a/b`, 'cone');
  assert.notEqual(unread.status, 0);
  assert.match(unread.stderr, notRun);
  assert.deepEqual(await sh(`${BIN}/basename /a/b`), { status: 0, stdout: 'b\n', stderr: '' });
});
