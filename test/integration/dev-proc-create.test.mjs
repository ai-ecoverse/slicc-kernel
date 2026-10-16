import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

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

const JS = `export default async function main(ctx) {
  const out = [];
  for (const p of ctx.argv.slice(1)) {
    try {
      ctx.sync.fs.mkdir(p);
      out.push(p + ' ok');
    } catch (err) {
      out.push(p + ' ' + err.code);
    }
  }
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

const PY = [
  'import os',
  "for p in ['/dev/p', '/proc/p']:",
  '    for name, make in [("open", lambda q: open(q, "w").write("y")), ("mkdir", os.mkdir)]:',
  '        try:',
  '            make(p + name)',
  "            print(name, p, 'ok')",
  '        except OSError as err:',
  '            print(name, p, err.strerror)',
].join('\n');

const SH = [
  'for p in /dev/e /proc/e; do',
  '  echo x > $p 2>/dev/null; echo "write $p $?"',
  '  mkdir ${p}d 2>/dev/null; echo "mkdir $p $?"',
  '  ln -s x ${p}l 2>/dev/null; echo "symlink $p $?"',
  'done',
  'echo x > /dev/null; echo "null $?"',
  'echo x > /dev/shm/kept && cat /dev/shm/kept',
].join('\n');

for (const [who, denied] of [
  ['root', 'Operation not permitted'],
  ['cone', 'Permission denied'],
]) {
  test(`a new name in /dev or /proc fails in every runtime instead of vanishing, and /dev/shm and the devices still work (${who})`, async (t) => {
    const kernel = await createNodeKernel({ users: 'enforce' });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
    await kernel.writeFile(
      '/node_modules/devmk/package.json',
      JSON.stringify({
        name: 'devmk',
        slicc: { commands: { devmk: { abi: 'js', module: 'main.mjs' } } },
      })
    );
    await kernel.writeFile('/node_modules/devmk/main.mjs', JS);
    await kernel.users.add({ name: 'cone' });
    const opts = { cwd: '/', ...(who === 'root' ? {} : { user: who }) };
    const sh = await kernel.run(['bash', '-c', SH], opts);
    assert.equal(
      sh.stdout,
      [
        'write /dev/e 1',
        'mkdir /dev/e 1',
        'symlink /dev/e 1',
        'write /proc/e 1',
        'mkdir /proc/e 1',
        'symlink /proc/e 1',
        'null 0',
        'x',
        '',
      ].join('\n'),
      sh.stderr
    );
    const py = await kernel.run(['python3', '-c', PY], opts);
    assert.equal(
      py.stdout,
      [
        `open /dev/p ${denied}`,
        `mkdir /dev/p ${denied}`,
        'open /proc/p Read-only file system',
        'mkdir /proc/p Read-only file system',
        '',
      ].join('\n'),
      py.stderr
    );
    const code = who === 'root' ? 'EPERM' : 'EACCES';
    const js = await kernel.run(['devmk', '/dev/j', '/proc/j'], opts);
    assert.equal(js.stdout, `/dev/j ${code}\n/proc/j EROFS\n`);
    const ls = await kernel.run(
      ['bash', '-c', 'ls /dev/e /dev/ed /dev/p* /dev/j 2>/dev/null | wc -l'],
      opts
    );
    assert.equal(ls.stdout, '0\n');
  });
}
