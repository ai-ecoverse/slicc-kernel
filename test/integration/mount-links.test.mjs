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

const WRITER = `export default async function main(ctx) {
  try {
    await ctx.fs.writeFile(ctx.argv[1], ctx.argv[2]);
    return 0;
  } catch (err) {
    await ctx.write(2, (err.code ?? err.message) + '\\n');
    return 1;
  }
}
`;

const SHAPES = [
  ['mount -> root', '/mnt/t/todir', '/srv/dir'],
  ['mount -> root -> mount', '/mnt/t/back/u', '/mnt/u'],
  ['root -> mount -> root', '/srv/tm/end', '/srv/end'],
  ['inside one mount', '/mnt/t/inner', '/mnt/t/real'],
];

test('WASIX and JS programs write through every symlink shape between the root and mounts (#623)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/linkwriter/package.json',
    JSON.stringify({
      name: 'linkwriter',
      slicc: { commands: { linkwriter: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/linkwriter/main.mjs', WRITER);
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  await bash('mkdir -p /mnt/t /mnt/u');
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/u' });
  const setup = [
    'mkdir -p /srv/dir /srv/end /srv/mid /mnt/t/real',
    'ln -s /srv/dir /mnt/t/todir',
    'ln -s /srv/mid /mnt/t/back',
    'ln -s /mnt/u /srv/mid/u',
    'ln -s /mnt/t /srv/tm',
    'ln -s /srv/end /mnt/t/end',
    'ln -s real /mnt/t/inner',
  ].join(' && ');
  assert.equal((await bash(setup)).status, 0);
  for (const [shape, link, target] of SHAPES) {
    const py = await kernel.run(['python3', '-c', `open("${link}/py", "w").write("python")`], {
      cwd: '/',
    });
    assert.equal(py.status, 0, `${shape}, python: ${py.stderr}`);
    const js = await kernel.run(['linkwriter', `${link}/js`, 'js'], { cwd: '/' });
    assert.equal(js.status, 0, `${shape}, js: ${js.stderr}`);
    const landed = await bash(`cat ${target}/py; echo; cat ${target}/js`);
    assert.deepEqual(landed, { status: 0, stdout: 'python\njs', stderr: '' }, shape);
  }
});
