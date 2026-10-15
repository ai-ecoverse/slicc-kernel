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

const JS = `export default async function main(ctx) {
  const out = [];
  const t = async (name, run) => {
    try {
      await run();
      out.push(name + ' ok');
    } catch (err) {
      out.push(name + ' ' + (err.code ?? err.message));
    }
  };
  await t('sync.unlink', () => ctx.sync.fs.unlink('/dev/null'));
  await t('sync.rm', () => ctx.sync.fs.rm('/dev'));
  await t('fs.rm', () => ctx.fs.rm('/dev'));
  await t('fs.unlink', () => ctx.fs.unlink('/dev/zero'));
  out.push('left ' + ctx.sync.fs.exists('/dev/null') + ' ' + ctx.sync.fs.exists('/dev/zero'));
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

const PY = [
  'import os',
  "for name, path, remove in [('unlink', '/dev/null', os.unlink), ('rmdir', '/dev', os.rmdir)]:",
  '    try:',
  '        remove(path)',
  "        print(name, 'ok')",
  '    except OSError as err:',
  '        print(name, err.strerror)',
  "print('left', os.path.exists('/dev/null'))",
].join('\n');

const SH =
  'rm -f /dev/null; echo rc=$?; rmdir /dev; echo rc=$?; unlink /dev/zero; echo rc=$?; rm -rf /dev 2>/dev/null; echo rc=$?; ls /dev/null /dev/zero';

const CASES = {
  root: {
    js: 'sync.unlink EPERM\nsync.rm EBUSY\nfs.rm EBUSY\nfs.unlink EPERM\nleft true true\n',
    py: 'unlink Operation not permitted\nrmdir Resource busy\nleft True\n',
    errors: [
      "rm: cannot remove '/dev/null': Operation not permitted",
      "rmdir: failed to remove '/dev': Resource busy",
      "unlink: cannot unlink '/dev/zero': Operation not permitted",
    ],
  },
  cone: {
    js: 'sync.unlink EACCES\nsync.rm EACCES\nfs.rm EACCES\nfs.unlink EACCES\nleft true true\n',
    py: 'unlink Permission denied\nrmdir Permission denied\nleft True\n',
    errors: [
      "rm: cannot remove '/dev/null': Permission denied",
      "rmdir: failed to remove '/dev': Permission denied",
      "unlink: cannot unlink '/dev/zero': Permission denied",
    ],
  },
};

test('removing a /dev entry fails and leaves it: EACCES for a user, EPERM or EBUSY for root (#637)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/devrm/package.json',
    JSON.stringify({
      name: 'devrm',
      slicc: { commands: { devrm: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/devrm/main.mjs', JS);
  await kernel.users.add({ name: 'cone' });
  for (const [who, want] of Object.entries(CASES)) {
    const opts = { cwd: '/', ...(who === 'root' ? {} : { user: who }) };
    const js = await kernel.run(['devrm'], opts);
    assert.equal(js.stdout, want.js, `${who} js`);
    const py = await kernel.run(['python3', '-c', PY], opts);
    assert.equal(py.stdout, want.py, `${who} python: ${py.stderr}`);
    const sh = await kernel.run(['bash', '-c', SH], opts);
    assert.equal(
      sh.stdout,
      'rc=1\nrc=1\nrc=1\nrc=1\n/dev/null\n/dev/zero\n',
      `${who} sh: ${sh.stderr}`
    );
    assert.deepEqual(sh.stderr.trim().split('\n'), want.errors, `${who} sh`);
  }
});
