import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixtures = new URL('./fixtures/', import.meta.url);

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

async function installFixture(kernel, name) {
  const base = new URL(`${name}/`, fixtures);
  for (const file of ['package.json', `bin/${name}`, `bin/${name}.wasm`]) {
    await kernel.writeFile(`/node_modules/${name}/${file}`, await readFile(new URL(file, base)));
  }
}

async function boot(t, ...packages) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', ...packages]) await install(kernel, name);
  await installFixture(kernel, 'preh1stat');
  await kernel.users.add({ name: 'cone' });
  return (script, user) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
}

const LEGACY = 'preh1stat /tmp /';
const PROBE = 'stat -c "%u %g" /tmp; ls -ln / | tail -1 | tr -s " " | cut -d" " -f3,4';
const REPO =
  'git init -q "$HOME/r" && cd "$HOME/r" && git status --short && echo "ok $(git rev-parse --is-inside-work-tree)"';

test('an Emscripten program without the credential ABI (preh1stat) sees every file as 1000:1000, as root and as a user', async (t) => {
  const glue = await readFile(new URL('preh1stat/bin/preh1stat', fixtures), 'utf8');
  assert.ok(
    !glue.includes('slicc_cred_js'),
    'the preh1stat fixture must be built without the credential library'
  );
  const bash = await boot(t);
  const owners = {
    status: 0,
    stdout: 'ids 0 0 0 0\n1000 1000 /tmp\n1000 1000 /\n',
    stderr: '',
  };
  assert.deepEqual(await bash(LEGACY), owners);
  assert.deepEqual(await bash(LEGACY, 'cone'), owners);
});

test('an Emscripten program with the credential ABI sees every file as its own, as root and as a user', async (t) => {
  const bash = await boot(t);
  assert.deepEqual(await bash(PROBE), { status: 0, stdout: '0 0\n0 0\n', stderr: '' });
  const [uid, gid] = (await bash('id -u cone; id -g cone')).stdout.trim().split('\n');
  assert.deepEqual(await bash(PROBE, 'cone'), {
    status: 0,
    stdout: `${uid} ${gid}\n${uid} ${gid}\n`,
    stderr: '',
  });
});

test('git with the credential ABI works on its own repository as root and as a user', async (t) => {
  const bash = await boot(t, 'wasm-git');
  for (const user of [undefined, 'cone']) {
    assert.deepEqual(await bash(REPO, user), { status: 0, stdout: 'ok true\n', stderr: '' });
  }
});
