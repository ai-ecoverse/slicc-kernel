import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name, skip) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    if (skip?.test(relative(fileURLToPath(base), file))) continue;
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

const SETUP = [
  'mkdir -p /tmp/pbin /tmp/later',
  "printf '#!/bin/sh\\necho script ran\\n' > /tmp/pbin/myscript",
  'chmod 755 /tmp/pbin/myscript',
  "printf '#!/bin/sh\\necho never\\n' > /tmp/pbin/noexec",
  'chmod 644 /tmp/pbin/noexec',
  "printf '#!/bin/sh\\necho shadowed\\n' > /tmp/later/seq",
  'chmod 755 /tmp/later/seq',
  'export PATH="/nowhere::/tmp/pbin:$PATH:/tmp/later"',
].join('; ');

test('timeout (posix_spawnp) finds a command by name in the PATH it was given when the catalog has none: a script and a copied WASI binary; a missing name is 127, a non-executable one 126, and a catalog command still wins (#1165)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile(
    '/tmp/myrg.wasm',
    await readFile(new URL('wasi-ripgrep/bin/rg.wasm', modules))
  );
  const r = await kernel.run(
    [
      'bash',
      '-c',
      `${SETUP}; cp /tmp/myrg.wasm /tmp/pbin/myrg; chmod 755 /tmp/pbin/myrg; cd /tmp; for c in myscript "myrg --version" missing noexec "seq 2"; do out=$(timeout 5 $c 2>&1); rc=$?; echo "$c => rc $rc $(printf %s "$out" | head -1)"; done`,
    ],
    { cwd: '/' }
  );
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 5, r.stdout + r.stderr);
  assert.match(lines[0], /^myscript => rc 0 script ran$/);
  assert.match(lines[1], /^myrg --version => rc 0 ripgrep \d/);
  assert.match(lines[2], /^missing => rc 127 .*No such file or directory/);
  assert.match(lines[3], /^noexec => rc 126 .*Permission denied/);
  assert.match(lines[4], /^seq 2 => rc 0 1$/);
});

const PY = [
  'import os',
  'env = dict(os.environ)',
  "for name, fn in (('spawn', os.posix_spawn), ('spawnp', os.posix_spawnp)):",
  '    try:',
  "        pid = fn('pyfound', ['pyfound'], env)",
  "        print(name, 'ran', os.waitpid(pid, 0)[1] >> 8, flush=True)",
  '    except OSError as e:',
  '        print(name, type(e).__name__, flush=True)',
].join('\n');

test('a WASIX posix_spawn that asks for no PATH search keeps its bare name: absent from the cwd it is ENOENT even though PATH has it; posix_spawnp still finds it (#1165)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  const script = `mkdir -p /tmp/pbin /tmp/empty; printf '#!/bin/sh\\nexit 7\\n' > /tmp/pbin/pyfound; chmod 755 /tmp/pbin/pyfound; export PATH="/tmp/pbin:$PATH"; cd /tmp/empty; python3 -c "$(echo ${Buffer.from(PY).toString('base64')} | base64 -d)"`;
  const r = await kernel.run(['bash', '-c', script], { cwd: '/' });
  assert.equal(r.stdout, 'spawn FileNotFoundError\nspawnp ran 7\n', r.stderr);
});

test('a bare name spawned by timeout (posix_spawnp) never runs a file of that name in the cwd when PATH has no empty or . entry: 127 as on Linux, for a user, while an empty PATH entry still finds it (#1234, homescoop#1362)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const r = await kernel.run(
    [
      'bash',
      '-c',
      [
        'mkdir -p /tmp/e && cd /tmp/e',
        "printf '#!/bin/sh\\necho cwd-ran\\n' > hscwd && chmod 755 hscwd",
        'out=$(timeout 5 hscwd 2>&1); echo "timeout rc=$? $out"',
        'hscwd 2>/dev/null; echo "bash rc=$?"',
        'out=$(PATH="$PATH:" timeout 5 hscwd 2>&1); echo "empty entry rc=$? $out"',
      ].join('; '),
    ],
    { cwd: '/home/cone', user: 'cone' }
  );
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3, r.stdout + r.stderr);
  assert.match(lines[0], /^timeout rc=127 .*No such file or directory/);
  assert.equal(lines[1], 'bash rc=127');
  assert.equal(lines[2], 'empty entry rc=0 cwd-ran');
});

test("a user's own pnpm-global command run by a bare name through timeout (posix_spawnp) is the user's, also when a system command has the same name (#1241 review)", {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const sh = (script, user) =>
    kernel.run(['bash', '-c', script], user ? { cwd: '/home/cone', user } : { cwd: '/' });
  const pkg = (name, text) =>
    `mkdir -p ${name}/bin && printf '#!/bin/sh\\necho ${text}\\n' > ${name}/bin/run && chmod 755 ${name}/bin/run`;
  const g = '/home/cone/.local/share/pnpm/global/5/g/node_modules';
  await sh(
    [
      `${pkg(`${g}/mine`, 'mine ran')} && echo '{"name":"mine","slicc":{"commands":{"mine":{"script":"bin/run"},"both":{"script":"bin/run"}}}}' > ${g}/mine/package.json`,
      `${pkg('/node_modules/sys', 'system ran')} && echo '{"name":"sys","slicc":{"commands":{"both":{"script":"bin/run"}}}}' > /node_modules/sys/package.json`,
      'chown -R cone:cone /home/cone/.local',
    ].join(' && ')
  );
  const r = await sh('timeout 5 mine; timeout 5 both; echo done', 'cone');
  assert.equal(r.stdout, 'mine ran\nmine ran\ndone\n', r.stderr);
});
