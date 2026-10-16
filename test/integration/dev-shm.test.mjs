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

const JS = `const decode = (b) => new TextDecoder().decode(b);
export default async function main(ctx) {
  const [op, path, text] = ctx.argv.slice(1);
  const out = [];
  try {
    if (op === 'write') await ctx.fs.writeFile(path, text);
    if (op === 'read') out.push(decode(await ctx.fs.readFile(path)), decode(ctx.sync.fs.readFile(path)));
    if (op === 'ls') out.push((await ctx.fs.readdir(path)).sort().join(','));
    if (op === 'mode') out.push((ctx.sync.fs.stat(path).mode & 0o7777).toString(8));
    if (op === 'rm') await ctx.fs.unlink(path);
    out.push('ok');
  } catch (err) {
    out.push(err.code ?? err.message);
  }
  await ctx.write(1, out.join(' ') + '\\n');
}
`;

const PY = (op, path, text = '') =>
  [
    'import os, stat',
    `op, path, text = ${JSON.stringify(op)}, ${JSON.stringify(path)}, ${JSON.stringify(text)}`,
    'try:',
    "    if op == 'write': open(path, 'w').write(text)",
    "    if op == 'read': print(open(path).read(), end=' ')",
    "    if op == 'ls': print(','.join(sorted(os.listdir(path))), end=' ')",
    "    if op == 'mode': print(oct(stat.S_IMODE(os.stat(path).st_mode))[2:], end=' ')",
    "    if op == 'rm': os.unlink(path)",
    "    print('ok')",
    'except OSError as err:',
    '    print(err.strerror)',
  ].join('\n');

async function booted(t, users) {
  const kernel = await createNodeKernel({ users });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/shmjs/package.json',
    JSON.stringify({
      name: 'shmjs',
      slicc: { commands: { shmjs: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/shmjs/main.mjs', JS);
  const opts = (user) => ({ cwd: '/', ...(user ? { user } : {}) });
  return {
    kernel,
    sh: (script, user) => kernel.run(['bash', '-c', script], opts(user)),
    js: (args, user) => kernel.run(['shmjs', ...args], opts(user)),
    py: (args, user) => kernel.run(['python3', '-c', PY(...args)], opts(user)),
  };
}

for (const users of ['enforce', 'off']) {
  test(`/dev/shm is one tmpfs for every process: create, write, read back, ls and unlink from Emscripten, WASI and JS (users: ${users})`, async (t) => {
    const { kernel, sh, js, py } = await booted(t, users);
    const made = await sh('echo e > /dev/shm/e; echo rc=$?');
    assert.equal(made.stdout, 'rc=0\n', made.stderr);
    assert.equal((await py(['write', '/dev/shm/p', 'p'])).stdout, 'ok\n');
    assert.equal((await js(['write', '/dev/shm/j', 'j'])).stdout, 'ok\n');
    const read = await sh('cat /dev/shm/e /dev/shm/p /dev/shm/j; echo; ls -A /dev/shm');
    assert.equal(read.stdout, 'e\npj\ne\nj\np\n', read.stderr);
    assert.equal((await py(['read', '/dev/shm/j'])).stdout, 'j ok\n');
    assert.equal((await py(['ls', '/dev/shm'])).stdout, 'e,j,p ok\n');
    assert.equal((await js(['read', '/dev/shm/p'])).stdout, 'p p ok\n');
    assert.equal((await js(['ls', '/dev/shm'])).stdout, 'e,j,p ok\n');
    assert.equal(new TextDecoder().decode(await kernel.readFile('/dev/shm/e')), 'e\n');
    assert.equal((await sh('stat -c %a /dev/shm')).stdout, '1777\n');
    assert.equal((await py(['mode', '/dev/shm'])).stdout, '1777 ok\n');
    assert.equal((await js(['mode', '/dev/shm'])).stdout, '1777 ok\n');
    assert.match((await sh('cat /proc/mounts')).stdout, /^shm \/dev\/shm tmpfs /m);
    assert.deepEqual(await kernel.mounts(), []);
    assert.equal((await sh('rm /dev/shm/e; echo rc=$?')).stdout, 'rc=0\n');
    assert.equal((await py(['rm', '/dev/shm/p'])).stdout, 'ok\n');
    assert.equal((await js(['rm', '/dev/shm/j'])).stdout, 'ok\n');
    assert.equal((await sh('ls -A /dev/shm | wc -l')).stdout, '0\n');
    assert.equal((await sh('rm -f /dev/null; echo rc=$?')).stdout, 'rc=1\n');
  });
}

test("/dev/shm is sticky under users: a user cannot remove or replace another user's file there, its owner can", async (t) => {
  const { kernel, sh, js, py } = await booted(t, 'enforce');
  await kernel.users.add({ name: 'alice' });
  await kernel.users.add({ name: 'bob' });
  assert.equal((await sh('echo a > /dev/shm/a; stat -c %U /dev/shm/a', 'alice')).stdout, 'alice\n');
  const bob = await sh(
    'rm -f /dev/shm/a; echo rc=$?; mv /dev/shm/a /dev/shm/b 2>/dev/null; echo rc=$?',
    'bob'
  );
  assert.equal(bob.stdout, 'rc=1\nrc=1\n');
  assert.match(bob.stderr, /Operation not permitted/);
  assert.equal((await py(['rm', '/dev/shm/a'], 'bob')).stdout, 'Operation not permitted\n');
  assert.equal((await js(['rm', '/dev/shm/a'], 'bob')).stdout, 'EPERM\n');
  assert.equal((await sh('cat /dev/shm/a', 'bob')).stdout, 'a\n');
  assert.equal((await sh('echo b > /dev/shm/b; echo rc=$?', 'bob')).stdout, 'rc=0\n');
  assert.equal((await sh('rm /dev/shm/a; echo rc=$?', 'alice')).stdout, 'rc=0\n');
});
