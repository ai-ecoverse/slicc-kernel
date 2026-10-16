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

export const NAMES = ['café.txt', 'Ünïcödé', '日本語.txt', '😀 emoji.txt'];

const SH = `cd "$1" && for n in ${NAMES.map((n) => `'${n}'`).join(' ')}; do
  printf '%s' "$n" > "$n" || exit 1
done
mkdir 'dir ü' || exit 1
for n in ${NAMES.map((n) => `'${n}'`).join(' ')}; do stat -c '%F %s' "$n"; cat "$n"; echo; done
mv 'café.txt' '名前.txt' && cat '名前.txt' && echo
ls -A | LC_ALL=C sort
rm -rf -- * && ls -A | wc -l`;

const PY = (dir) =>
  [
    'import os',
    `os.chdir(${JSON.stringify(dir)})`,
    `names = ${JSON.stringify(NAMES)}`,
    'for n in names:',
    '    open(n, "w").write(n)',
    'os.mkdir("dir ü")',
    'for n in names:',
    '    print(os.path.isfile(n), os.stat(n).st_size, open(n).read())',
    'os.rename("café.txt", "名前.txt")',
    'print(open("名前.txt").read())',
    'print(sorted(os.listdir(".")))',
    'for n in os.listdir("."):',
    '    (os.rmdir if os.path.isdir(n) else os.unlink)(n)',
    'print(len(os.listdir(".")))',
  ].join('\n');

const JS = `export default async function main(ctx) {
  const dir = ctx.argv[1];
  const names = ${JSON.stringify(NAMES)};
  const out = [];
  for (const n of names) await ctx.fs.writeFile(dir + '/' + n, n);
  await ctx.fs.mkdir(dir + '/dir ü');
  for (const n of names) {
    const st = await ctx.fs.stat(dir + '/' + n);
    out.push([st.isFile, st.size, new TextDecoder().decode(await ctx.fs.readFile(dir + '/' + n))].join(' '));
  }
  await ctx.fs.rename(dir + '/café.txt', dir + '/名前.txt');
  out.push(new TextDecoder().decode(ctx.sync.fs.readFile(dir + '/名前.txt')));
  out.push((await ctx.fs.readdir(dir)).sort().join('|'));
  for (const n of await ctx.fs.readdir(dir)) await ctx.fs.rm(dir + '/' + n);
  out.push(String((await ctx.fs.readdir(dir)).length));
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

const bytes = (n) => Buffer.byteLength(n);
const sorted = (list) => [...list].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

for (const users of ['enforce', 'off']) {
  test(`names with é, ü, CJK and emoji are created, stat'd, listed, renamed and removed by Emscripten, WASI and JS programs (users: ${users})`, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
    await kernel.writeFile(
      '/node_modules/u8/package.json',
      JSON.stringify({ name: 'u8', slicc: { commands: { u8: { abi: 'js', module: 'main.mjs' } } } })
    );
    await kernel.writeFile('/node_modules/u8/main.mjs', JS);
    const after = sorted(['Ünïcödé', '日本語.txt', '😀 emoji.txt', '名前.txt', 'dir ü']);
    for (const dir of ['/tmp/e', '/home/e', '/tmp/p', '/tmp/j']) {
      await kernel.run(['mkdir', '-p', dir], { cwd: '/' });
    }
    for (const dir of ['/tmp/e', '/home/e']) {
      const sh = await kernel.run(['bash', '-c', SH, 'sh', dir], { cwd: '/' });
      assert.equal(sh.stderr, '', dir);
      assert.equal(
        sh.stdout,
        [
          ...NAMES.flatMap((n) => [`regular file ${bytes(n)}`, n]),
          'café.txt',
          ...after,
          '0',
          '',
        ].join('\n'),
        dir
      );
    }
    const py = await kernel.run(['python3', '-c', PY('/tmp/p')], { cwd: '/' });
    assert.equal(py.stderr, '');
    assert.equal(
      py.stdout,
      [
        ...NAMES.map((n) => `True ${bytes(n)} ${n}`),
        'café.txt',
        `[${[...after]
          .sort()
          .map((n) => `'${n}'`)
          .join(', ')}]`,
        '0',
        '',
      ].join('\n')
    );
    const js = await kernel.run(['u8', '/tmp/j'], { cwd: '/' });
    assert.equal(
      js.stdout,
      [
        ...NAMES.map((n) => `true ${bytes(n)} ${n}`),
        'café.txt',
        [...after].sort().join('|'),
        '0',
        '',
      ].join('\n'),
      js.stderr
    );
  });
}
