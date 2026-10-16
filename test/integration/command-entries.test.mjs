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

const HELLO = '#!/bin/bash\necho "hello $HELLO_FROM"\n';

async function booted(t, users = 'enforce') {
  const kernel = await createNodeKernel({ users });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/hello/package.json',
    JSON.stringify({
      name: 'hello',
      slicc: { commands: { hello: { script: 'bin/hello', env: { HELLO_FROM: 'the manifest' } } } },
    })
  );
  await kernel.writeFile('/node_modules/hello/bin/hello', HELLO);
  const bash = (script, user) => kernel.run(['bash', '-c', script], { cwd: '/', user });
  return { kernel, bash };
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

test('a command entry reads as its program: the script, or the wasm, with its size, and exec still runs the command (#762)', async (t) => {
  const { bash } = await booted(t);
  assert.deepEqual(await bash('cat /usr/bin/hello'), ok(HELLO));
  assert.deepEqual(await bash('cat /bin/hello'), ok(HELLO));
  assert.deepEqual(
    await bash(
      '[ -s /usr/bin/hello ] && [ -x /usr/bin/hello ] && echo sx; stat -c "%s %a %U %F" /usr/bin/hello; wc -c < /node_modules/hello/bin/hello'
    ),
    ok(`sx\n${HELLO.length} 755 root regular file\n${HELLO.length}\n`)
  );
  assert.deepEqual(
    await bash('head -c4 /usr/bin/cat | od -An -c | tr -s " "; ls -l /usr/bin/cat | cut -c1-10'),
    ok(' \\0 a s m\n-rwxr-xr-x\n')
  );
  assert.deepEqual(await bash('readlink /usr/bin/hello; echo $?'), ok('1\n'));
  assert.deepEqual(
    await bash('command -v hello; which hello 2>/dev/null || type -P hello'),
    ok('/usr/bin/hello\n/usr/bin/hello\n')
  );
  assert.deepEqual(
    await bash('hello; /usr/bin/hello; bash /usr/bin/hello'),
    ok('hello the manifest\nhello the manifest\nhello \n')
  );
});

test('under enforce, a user command entry is read as the user: a target the user cannot read is EACCES and shows size 0 (#762)', async (t) => {
  const { kernel, bash } = await booted(t);
  await kernel.users.add({ name: 'cone' });
  const pkg = '/home/cone/.local/share/pnpm/global/5/g/node_modules/peek';
  await bash('echo secret > /root/secret && chmod 600 /root/secret');
  await bash(
    `mkdir -p ${pkg}/bin && ln -s /root/secret ${pkg}/bin/peek && echo '{"name":"peek","slicc":{"commands":{"peek":{"script":"bin/peek"}}}}' > ${pkg}/package.json && chown -R cone:cone /home/cone/.local`
  );
  const bin = '/home/cone/.local/share/pnpm/bin/peek';
  const asCone = await bash(`stat -c "%s %F" ${bin}; cat ${bin}; echo rc=$?`, 'cone');
  assert.equal(asCone.stdout, '0 regular empty file\nrc=1\n');
  assert.match(asCone.stderr, /^cat: .*peek: Permission denied\n$/);
  const ran = await bash('peek; echo rc=$?', 'cone');
  assert.doesNotMatch(ran.stdout, /secret/);
  assert.match(ran.stdout, /rc=12[67]\n$/);
  assert.deepEqual(await bash(`cat ${bin}`), ok('secret\n'));
  const mine = '/home/cone/.local/share/pnpm/global/5/g/node_modules/mine';
  await bash(
    `mkdir -p ${mine}/bin && printf 'echo mine\\n' > ${mine}/bin/mine && echo '{"name":"mine","slicc":{"commands":{"mine":{"script":"bin/mine"}}}}' > ${mine}/package.json && chown -R cone:cone /home/cone/.local`
  );
  const own = '/home/cone/.local/share/pnpm/bin/mine';
  assert.deepEqual(
    await bash(
      `[ -s ${own} ] && echo s; stat -c %s ${own}; ls -l ${own} | cut -d" " -f5; cat ${own}`,
      'cone'
    ),
    ok('s\n10\n10\necho mine\n')
  );
  assert.deepEqual(await bash(`stat -c %s ${own}`), ok('10\n'));
  const py = `python3 -c "import os, sys; print(os.stat(sys.argv[1]).st_size, os.path.getsize(sys.argv[1]))" ${own}`;
  assert.deepEqual(await bash(py, 'cone'), ok('10 10\n'));
  await kernel.users.add({ name: 'bob' });
  const bob = await bash(`stat -c %s ${own}; echo rc=$?`, 'bob');
  assert.equal(bob.stdout, 'rc=1\n');
  assert.match(bob.stderr, /Permission denied/);
  await bash('chmod 700 /node_modules/hello/bin/hello');
  const shown =
    'stat -c %s /usr/bin/hello; [ -s /usr/bin/hello ] || echo empty; cat /usr/bin/hello; echo rc=$?';
  const cone = await bash(shown, 'cone');
  assert.equal(cone.stdout, '0\nempty\nrc=1\n');
  assert.match(cone.stderr, /Permission denied/);
  assert.deepEqual(await bash(shown), ok(`${HELLO.length}\n${HELLO}rc=0\n`));
});
