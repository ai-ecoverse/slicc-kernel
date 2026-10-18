import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';

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

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python', 'wasm-sqlite3']) {
    await install(kernel, name);
  }
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp' });
}

const MARK = 'echo ".output ready"; echo "select 1;"; echo ".output stdout";';

test('an open sqlite connection sees another process commit, and keeps its row (#665)', async (t) => {
  const bash = await booted(t);
  const r = await bash(`
    sqlite3 v.db 'create table t(x); insert into t values(0);'
    ( echo "select 'A1', group_concat(x) from t;"; ${MARK}
      until [ -e go ]; do sleep 0.05; done
      echo "select 'A2', group_concat(x) from t;"; echo "insert into t values(7);" ) | sqlite3 v.db > a.out &
    until [ -e ready ]; do sleep 0.05; done
    sqlite3 v.db 'insert into t values(5);'
    touch go; wait
    cat a.out; sqlite3 v.db 'select group_concat(x) from t'`);
  assert.deepEqual(r, { status: 0, stdout: 'A1|0\nA2|0,5\n0,5,7\n', stderr: '' });
});

test('python sqlite3 sees a commit of the sqlite3 CLI while its connection is open (#665)', async (t) => {
  const bash = await booted(t);
  const py = [
    'import os, sqlite3, time',
    "c = sqlite3.connect('p.db')",
    "print('P1', c.execute('select group_concat(x) from t').fetchone()[0])",
    "open('ready', 'w').close()",
    "while not os.path.exists('go'): time.sleep(0.05)",
    "print('P2', c.execute('select group_concat(x) from t').fetchone()[0])",
    "c.execute('insert into t values(9)'); c.commit()",
  ].join('\n');
  const r = await bash(`
    sqlite3 p.db 'create table t(x); insert into t values(0);'
    python3 -c "${py}" > p.out &
    until [ -e ready ]; do sleep 0.05; done
    sqlite3 p.db 'insert into t values(1);'
    touch go; wait
    cat p.out; sqlite3 p.db 'select group_concat(x) from t'`);
  assert.deepEqual(r, { status: 0, stdout: 'P1 0\nP2 0,1\n0,1,9\n', stderr: '' });
});

test('appenders in three processes keep every line of a shared log (#665)', async (t) => {
  const bash = await booted(t);
  const n = 100;
  const py = `import time\nf = open('log', 'a')\nfor i in range(${n}):\n    f.write('p%d\\\\n' % i); f.flush(); time.sleep(0.01)\n    while i == 0 and not all(m in open('log').read().split() for m in ('a1', 'b1')): time.sleep(0.01)`;
  const r = await bash(`
    exec 4< <(sleep 120); tick=$!
    python3 -c "${py}" &
    until [ -s log ]; do read -t 0.01 -u 4; done
    ( exec 3>>log; for i in $(seq ${n}); do echo "a$i" >&3; read -t 0.01 -u 4; done ) &
    ( exec 3>>log; for i in $(seq ${n}); do echo "b$i" >&3; read -t 0.01 -u 4; done ) &
    wait $(jobs -p)
    kill $tick; exec 4<&-
    a=0; b=0; p=0; at=0; lastp=0; firsta=0; firstb=0
    while read l; do
      at=$((at+1))
      case $l in a*) a=$((a+1)); [ $firsta = 0 ] && firsta=$at;; b*) b=$((b+1)); [ $firstb = 0 ] && firstb=$at;; p*) p=$((p+1)); lastp=$at;; esac
    done < log
    echo $a $b $p
    [ $firsta -lt $lastp ] && [ $firstb -lt $lastp ] && echo overlapped`);
  assert.deepEqual(r, { status: 0, stdout: `${n} ${n} ${n}\noverlapped\n`, stderr: '' });
});

async function program(kernel, name, source) {
  const base = `/node_modules/${name}`;
  await kernel.writeFile(
    `${base}/package.json`,
    JSON.stringify({ name, slicc: { commands: { [name]: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile(`${base}/main.mjs`, source);
}

async function heldKernel(t, root = memoryRoot()) {
  const kernel = await createNodeKernel({ users: 'enforce', root });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-sqlite3']) await install(kernel, name);
  return kernel;
}

async function stored(root, path) {
  let dir = root;
  const names = path.split('/').filter(Boolean);
  for (const name of names.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
  const file = await (await dir.getFileHandle(names.at(-1))).getFile();
  return Buffer.from(await file.arrayBuffer());
}

const HOLDER = `export default async function main(ctx) {
  const f = await ctx.open(ctx.argv[1], { read: true, write: true });
  await ctx.fs.writeFile('/tmp/opened', '');
  while (!(await ctx.fs.exists('/tmp/done'))) await new Promise((r) => setTimeout(r, 20));
  await f.close();
}
`;

test('a commit to a file the kernel holds open is in storage when the writer exits (#665)', async (t) => {
  const root = memoryRoot();
  const kernel = await heldKernel(t, root);
  await program(kernel, 'holder', HOLDER);
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp' });
  await bash(`sqlite3 c.db 'create table t(x);'`);
  const holder = kernel.run(['holder', '/tmp/c.db'], { cwd: '/' });
  const r = await bash(
    `until [ -e opened ]; do sleep 0.05; done; sqlite3 c.db "insert into t values('committed-row');"`
  );
  assert.deepEqual(r, { status: 0, stdout: '', stderr: '' });
  const kept = (await stored(root, '/tmp/c.db')).includes('committed-row');
  const read = Buffer.from(await kernel.readFile('/tmp/c.db')).includes('committed-row');
  await kernel.writeFile('/tmp/done', '');
  await holder;
  assert.deepEqual({ kept, read }, { kept: true, read: true });
});

const APPENDER = `export default async function main(ctx) {
  const f = await ctx.open('/tmp/log', { write: true, append: true, create: true });
  await ctx.fs.writeFile('/tmp/opened' + ctx.argv[1], '');
  const lines = Array.from({ length: 100 }, (_, i) => new TextEncoder().encode('k' + ctx.argv[1] + '.' + i + '\\n'));
  await Promise.all(lines.map((line) => f.write(0, line)));
  await f.close();
}
`;

test('an O_APPEND writer the kernel holds and a by-path appender keep every line (#665)', async (t) => {
  const kernel = await heldKernel(t);
  await program(kernel, 'appender', APPENDER);
  const r = await kernel.run(
    [
      'bash',
      '-c',
      `for a in 1 2 3; do appender $a & done; until [ -e opened1 ] && [ -e opened2 ] && [ -e opened3 ]; do :; done
      for p in 1 2 3; do ( for i in $(seq 100); do echo "b$p.$i" >> log; done ) & done; wait
      k=0; b=0; while read l; do case $l in k*) k=$((k+1));; b*) b=$((b+1));; esac; done < log
      echo $k $b; sort log | uniq -d | wc -l`,
    ],
    { cwd: '/tmp' }
  );
  assert.deepEqual(r, { status: 0, stdout: '300 300\n0\n', stderr: '' });
});

const WRITER = `export default async function main(ctx) {
  while (!(await ctx.fs.exists('/tmp/ready'))) await new Promise((r) => setTimeout(r, 10));
  const f = await ctx.open('/tmp/f', { read: true, write: true });
  await f.write(0, new TextEncoder().encode('new!'));
  await ctx.fs.writeFile('/tmp/wrote', '');
  while (!(await ctx.fs.exists('/tmp/done'))) await new Promise((r) => setTimeout(r, 10));
  await f.close();
}
`;

test("a reader with the file open sees a kernel-held writer's write before it is written back (#665)", async (t) => {
  const kernel = await heldKernel(t);
  await install(kernel, 'wasix-python');
  await program(kernel, 'writer', WRITER);
  const py = [
    'import os, time',
    "f = open('f', 'rb', buffering=0)",
    "print('P1', f.read().decode())",
    "open('ready', 'w').close()",
    "while not os.path.exists('wrote'): time.sleep(0.005)",
    'f.seek(0)',
    "print('P2', f.read().decode())",
    "open('done', 'w').close()",
  ].join('\n');
  const r = await kernel.run(
    ['bash', '-c', `printf 'old!' > f; writer & python3 -c "${py}"; wait`],
    { cwd: '/tmp' }
  );
  assert.deepEqual(r, { status: 0, stdout: 'P1 old!\nP2 new!\n', stderr: '' });
});
