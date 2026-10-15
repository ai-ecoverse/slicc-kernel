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

async function booted(t, packages = []) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-sqlite3', ...packages]) {
    await install(kernel, name);
  }
  await kernel.run(['mkdir', '-p', '/mnt/t'], { cwd: '/' });
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  return kernel;
}

const run = (kernel, script, cwd = '/tmp') => kernel.run(['bash', '-c', script], { cwd });

async function program(kernel, name, source) {
  await kernel.writeFile(
    `/node_modules/${name}/package.json`,
    JSON.stringify({ name, slicc: { commands: { [name]: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile(`/node_modules/${name}/main.mjs`, source);
}

const MARK = 'echo ".output ready"; echo "select 1;"; echo ".output stdout";';

const repro = (a, b) => `
  sqlite3 ${b} 'create table t(x); insert into t values(0);'
  ( echo "select 'A1', group_concat(x) from t;"; ${MARK}
    until [ -e go ]; do sleep 0.05; done
    echo "select 'A2', group_concat(x) from t;"; echo "insert into t values(7);" ) | sqlite3 ${a} > a.out &
  until [ -e ready ]; do sleep 0.05; done
  sqlite3 ${b} 'insert into t values(5);'
  touch go; wait
  cat a.out; sqlite3 ${b} 'select group_concat(x) from t'`;

test('an sqlite3 connection through a symlinked directory sees a commit made through the real path (#669)', async (t) => {
  const kernel = await booted(t);
  const r = await run(
    kernel,
    `mkdir real && ln -s real alias; ${repro('alias/v.db', 'real/v.db')}`
  );
  assert.deepEqual(r, { status: 0, stdout: 'A1|0\nA2|0,5\n0,5,7\n', stderr: '' });
});

test('an sqlite3 connection through one hard-link name sees a commit made through the other (#669)', async (t) => {
  const kernel = await booted(t);
  const r = await run(
    kernel,
    `sqlite3 v.db 'create table t(x); insert into t values(0);' && ln v.db w.db; ${repro('w.db', 'v.db').replace("sqlite3 v.db 'create table t(x); insert into t values(0);'", '')}`,
    '/mnt/t'
  );
  assert.deepEqual(r, { status: 0, stdout: 'A1|0\nA2|0,5\n0,5,7\n', stderr: '' });
});

const HOLDER = `export default async function main(ctx) {
  const f = await ctx.open(ctx.argv[1], { read: true, write: true, create: true });
  await f.write(0, new TextEncoder().encode('AAAA'));
  await ctx.fs.writeFile('/tmp/opened', '');
  while (!(await ctx.fs.exists('/tmp/go'))) await new Promise((r) => setTimeout(r, 20));
  await f.write(0, new TextEncoder().encode('C'));
  await f.close();
}
`;

test('a by-path write through a symlinked path reaches a file the kernel holds, and its write-back keeps it (#669)', async (t) => {
  const kernel = await booted(t);
  await program(kernel, 'holder', HOLDER);
  await run(kernel, 'mkdir real && ln -s real alias');
  const holder = kernel.run(['holder', '/tmp/real/held'], { cwd: '/' });
  const r = await run(
    kernel,
    'until [ -e opened ]; do sleep 0.05; done; printf BBBBBBBB > alias/held; cat real/held; echo; touch go'
  );
  await holder;
  const after = await run(kernel, 'cat real/held');
  assert.deepEqual([r.stdout, after.stdout], ['BBBBBBBB\n', 'CBBBBBBB']);
});

const TEE = `export default async function main(ctx) {
  try {
    ctx.sync.fs.writeFile(ctx.argv[1], 'sudo');
    await ctx.write(1, 'wrote\\n');
  } catch (err) {
    await ctx.write(1, err.code + '\\n');
  }
}
`;

test('under enforce, a sudo write through an untrusted symlink to a file the kernel holds is still refused (#669, #590)', async (t) => {
  const kernel = await booted(t);
  await program(kernel, 'holder', HOLDER);
  await program(kernel, 'put', TEE);
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await run(
    kernel,
    "printf '%s\\n' 'NOPASSWD cone Cmnd *' > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone && printf root > /tmp/rootfile && chmod 644 /tmp/rootfile",
    '/'
  );
  const holder = kernel.run(['holder', '/tmp/rootfile'], { cwd: '/' });
  await run(kernel, 'until [ -e /tmp/opened ]; do sleep 0.05; done', '/');
  const r = await kernel.run(['bash', '-c', 'ln -s /tmp/rootfile l && sudo put l'], {
    cwd: '/home/cone',
    user: 'cone',
  });
  await kernel.writeFile('/tmp/go', '');
  await holder;
  const after = await run(kernel, 'cat /tmp/rootfile', '/');
  assert.equal(r.stdout, 'EACCES\n');
  assert.equal(after.stdout, 'CAAA');
});

const PUT = `export default async function main(ctx) {
  await ctx.fs.writeFile(ctx.argv[1], ctx.argv[2]);
}
`;

test('a JS program writing by a symlinked path reaches a file the kernel holds (#669)', async (t) => {
  const kernel = await booted(t);
  await program(kernel, 'holder', HOLDER);
  await program(kernel, 'put', PUT);
  await run(kernel, 'mkdir real && ln -s real alias');
  const holder = kernel.run(['holder', '/tmp/real/held'], { cwd: '/' });
  const r = await run(
    kernel,
    'until [ -e opened ]; do sleep 0.05; done; put /tmp/alias/held BBBBBBBB; cat real/held; echo; touch go'
  );
  await holder;
  const after = await run(kernel, 'cat real/held');
  assert.deepEqual([r.stdout, after.stdout], ['BBBBBBBB\n', 'CBBBBBBB']);
});

test('python with a file open through a symlinked directory sees a write made through the real path (#669)', async (t) => {
  const kernel = await booted(t, ['wasix-python']);
  const py = [
    'import os, time',
    "f = open('alias/f', 'rb', buffering=0)",
    "print('P1', f.read().decode())",
    "open('ready', 'w').close()",
    "while not os.path.exists('go'): time.sleep(0.02)",
    'f.seek(0)',
    "print('P2', f.read().decode())",
  ].join('\n');
  const r = await run(
    kernel,
    `mkdir real && ln -s real alias && printf old! > real/f
    python3 -c "${py}" & until [ -e ready ]; do sleep 0.05; done
    printf new! > real/f; touch go; wait`
  );
  assert.deepEqual(r, { status: 0, stdout: 'P1 old!\nP2 new!\n', stderr: '' });
});

test('python writing through a symlinked directory reaches a file the kernel holds (#669)', async (t) => {
  const kernel = await booted(t, ['wasix-python']);
  await program(kernel, 'holder', HOLDER);
  await run(kernel, 'mkdir real && ln -s real alias');
  const holder = kernel.run(['holder', '/tmp/real/held'], { cwd: '/' });
  const r = await run(
    kernel,
    `until [ -e opened ]; do sleep 0.05; done; python3 -c "open('alias/held', 'w').write('BBBBBBBB')"; cat real/held; echo; touch go`
  );
  await holder;
  const after = await run(kernel, 'cat real/held');
  assert.deepEqual([r.stdout, after.stdout], ['BBBBBBBB\n', 'CBBBBBBB']);
});

for (const writer of ['put /tmp/link/f new!', `python3 -c "open('link/f', 'w').write('new!')"`]) {
  test(`python with a file open by its real path sees a write made through a symlinked directory (${writer.split(' ')[0]}, #669)`, async (t) => {
    const kernel = await booted(t, ['wasix-python']);
    await program(kernel, 'put', PUT);
    const py = [
      'import os, time',
      "f = open('real/f', 'rb', buffering=0)",
      "print('P1', f.read().decode())",
      "open('ready', 'w').close()",
      "while not os.path.exists('go'): time.sleep(0.02)",
      'f.seek(0)',
      "print('P2', f.read().decode())",
    ].join('\n');
    const r = await run(
      kernel,
      `mkdir real && ln -s real link && printf old! > real/f
      python3 -c "${py}" & until [ -e ready ]; do sleep 0.05; done
      ${writer}; touch go; wait`
    );
    assert.deepEqual(r, { status: 0, stdout: 'P1 old!\nP2 new!\n', stderr: '' });
  });
}

test('python writing through a hard link reaches the file the kernel holds under the other name (#669)', async (t) => {
  const kernel = await booted(t, ['wasix-python']);
  await program(kernel, 'holder', HOLDER);
  await run(kernel, 'printf AAAA > a && ln a b', '/mnt/t');
  const holder = kernel.run(['holder', '/mnt/t/a'], { cwd: '/' });
  const r = await run(
    kernel,
    `until [ -e /tmp/opened ]; do sleep 0.05; done; python3 -c "open('b', 'w').write('BBBBBBBB')"; cat a; echo; touch /tmp/go`,
    '/mnt/t'
  );
  await holder;
  const after = await run(kernel, 'cat a', '/mnt/t');
  assert.deepEqual([r.stdout, after.stdout], ['BBBBBBBB\n', 'CBBBBBBB']);
});

test('after a sudo write through a symlinked directory, a normal write through it still reaches a reader on the real path (#669)', async (t) => {
  const kernel = await booted(t, ['wasix-python']);
  await program(kernel, 'put', PUT);
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await run(
    kernel,
    "printf '%s\\n' 'NOPASSWD cone Cmnd *' > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone && mkdir -p /tmp/real && ln -s /tmp/real /tmp/link && printf old! > /tmp/real/f && chmod 666 /tmp/real/f",
    '/'
  );
  const py = [
    'import os, time',
    "f = open('/tmp/real/f', 'rb', buffering=0)",
    "print('P1', f.read().decode())",
    "open('/tmp/ready', 'w').close()",
    "while not os.path.exists('/tmp/go'): time.sleep(0.02)",
    'f.seek(0)',
    "print('P2', f.read().decode())",
  ].join('\n');
  const reader = run(kernel, `python3 -c "${py}"`, '/');
  const r = await kernel.run(
    [
      'bash',
      '-c',
      'until [ -e /tmp/ready ]; do sleep 0.05; done; sudo put /tmp/link/f sud!; put /tmp/link/f new!; touch /tmp/go',
    ],
    { cwd: '/home/cone', user: 'cone' }
  );
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.deepEqual(await reader, { status: 0, stdout: 'P1 old!\nP2 new!\n', stderr: '' });
});
