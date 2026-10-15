import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, from, as = from) {
  const base = new URL(`${from}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${as}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function boot(t, coreutils, git) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, coreutils, 'wasm-coreutils');
  if (git) await install(kernel, git, 'wasm-git');
  await kernel.users.add({ name: 'cone' });
  return (script, user) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
}

const PROBE = 'stat -c "%u %g" /tmp; ls -ln / | tail -1 | tr -s " " | cut -d" " -f3,4';
const REPO =
  'git init -q "$HOME/r" && cd "$HOME/r" && git status --short && echo "ok $(git rev-parse --is-inside-work-tree)"';

test('an Emscripten program without the credential ABI sees every file as 1000:1000, as root and as a user', async (t) => {
  const bash = await boot(t, 'wasm-coreutils-pre-h1');
  const owners = { status: 0, stdout: '1000 1000\n1000 1000\n', stderr: '' };
  assert.deepEqual(await bash(PROBE), owners);
  assert.deepEqual(await bash(PROBE, 'cone'), owners);
});

test('an Emscripten program with the credential ABI sees every file as its own, as root and as a user', async (t) => {
  const bash = await boot(t, 'wasm-coreutils');
  assert.deepEqual(await bash(PROBE), { status: 0, stdout: '0 0\n0 0\n', stderr: '' });
  const [uid, gid] = (await bash('id -u cone; id -g cone')).stdout.trim().split('\n');
  assert.deepEqual(await bash(PROBE, 'cone'), {
    status: 0,
    stdout: `${uid} ${gid}\n${uid} ${gid}\n`,
    stderr: '',
  });
});

test('git with the credential ABI works on its own repository as root and as a user', async (t) => {
  const bash = await boot(t, 'wasm-coreutils', 'wasm-git');
  for (const user of [undefined, 'cone']) {
    assert.deepEqual(await bash(REPO, user), { status: 0, stdout: 'ok true\n', stderr: '' });
  }
});
