import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

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

const HOME = '/home/cone/.local/share/pnpm';
const BIN = `${HOME}/bin`;
const ENTRY = `${BIN}/own`;
const ABSENT = `rm: cannot remove '${ENTRY}': No such file or directory\n`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const pkg = `${HOME}/global/5/g/node_modules/own`;
  const script = [
    `mkdir -p ${BIN} ${pkg}/bin`,
    `printf 'echo own\\n' > ${pkg}/bin/own`,
    `echo '{"name":"own","slicc":{"commands":{"own":{"script":"bin/own"}}}}' > ${pkg}/package.json`,
    'chown -R cone:cone /home/cone/.local',
  ];
  await kernel.run(['bash', '-c', script.join(' && ')], { cwd: '/' });
  const cone = (line) => kernel.run(['bash', '-c', line], { cwd: '/', user: 'cone' });
  const client = await attachKernel(await kernel.connect());
  const heard = [];
  const watch = await client.fs.watch([BIN, '/tmp'], { recursive: true }, (change) =>
    heard.push(change)
  );
  t.after(() => watch.close());
  const quiet = async () => {
    await settle();
    return heard.splice(0);
  };
  return { cone, client, quiet };
}

test('a command entry with no file behind it has nothing to unlink: rm -f does nothing, rm says ENOENT, the entry stays and no watcher hears of it', async (t) => {
  const { cone, quiet } = await booted(t);
  const r = await cone(
    `rm -f -- ${ENTRY}; echo f=$?; rm -- ${ENTRY}; echo plain=$?; stat -c %s ${ENTRY}`
  );
  assert.deepEqual(r, { status: 0, stdout: 'f=0\nplain=1\n9\n', stderr: ABSENT });
  assert.deepEqual(await quiet(), []);
});

test('a command entry someone has open answers as one nobody has open, not EBUSY', async (t) => {
  const { cone, quiet } = await booted(t);
  const r = await cone(
    `exec 3< ${ENTRY}; rm -f -- ${ENTRY}; echo f=$?; rm -- ${ENTRY}; echo plain=$?; cat <&3`
  );
  assert.deepEqual(r, { status: 0, stdout: 'f=0\nplain=1\necho own\n', stderr: ABSENT });
  assert.deepEqual(await quiet(), []);
});

test('a real file over a command entry is removed and heard once, and the entry under it then stays', async (t) => {
  const { cone, quiet } = await booted(t);
  const made = await cone(
    `echo mine > ${BIN}/.own; mv -f ${BIN}/.own ${ENTRY}; stat -c %s ${ENTRY}`
  );
  assert.deepEqual(made, { status: 0, stdout: '5\n', stderr: '' });
  await quiet();
  const r = await cone(`rm -f -- ${ENTRY}; echo rc=$?; stat -c %s ${ENTRY}`);
  assert.deepEqual(r, { status: 0, stdout: 'rc=0\n9\n', stderr: '' });
  assert.deepEqual(await quiet(), [{ paths: [ENTRY] }]);
  assert.equal((await cone(`rm -f -- ${ENTRY}; echo rc=$?`)).stdout, 'rc=0\n');
  assert.deepEqual(await quiet(), []);
});

test('a removal that failed or had nothing to do tells no watcher; one that happened does', async (t) => {
  const { cone, client, quiet } = await booted(t);
  await assert.rejects(client.fs.rm('/tmp/none'), { code: 'ENOENT' });
  assert.deepEqual(await quiet(), []);
  await client.fs.rm('/tmp/none', { force: true });
  assert.deepEqual(await quiet(), []);
  await cone('echo x > /tmp/real');
  await quiet();
  await client.fs.rm('/tmp/real');
  assert.deepEqual(await quiet(), [{ paths: ['/tmp/real'] }]);
});

test('a rename that failed tells no watcher', async (t) => {
  const { client, quiet } = await booted(t);
  await assert.rejects(client.fs.rename('/tmp/none', '/tmp/other'), { code: 'ENOENT' });
  assert.deepEqual(await quiet(), []);
});

test('pnpm remove -g takes out a package whose bin shim is already gone: the entry left answers ENOENT, which pnpm counts as removed', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm']) {
    await install(kernel, name);
  }
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile('/srv/tool.tgz', await shimmed());
  const script = [
    'pnpm add -g file:/srv/tool.tgz > /dev/null 2>&1; echo "add $?"',
    'rm -f -- "$PNPM_HOME/bin/shimmed"',
    'stat -c %s "$PNPM_HOME/bin/shimmed"',
    'pnpm remove -g shimmed > /dev/null 2>&1; echo "remove $?"',
    'ls -A "$PNPM_HOME/bin"',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', script], { cwd: '/home/cone', user: 'cone' });
  assert.equal(r.stdout, `add 0\n${TOOL.length}\nremove 0\n`, r.stderr);
});

const TOOL = 'export default async function main() { return 0; }\n';

async function shimmed() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-shimmed-'));
  await mkdir(join(dir, 'package', 'bin'), { recursive: true });
  const manifest = {
    name: 'shimmed',
    version: '1.0.0',
    bin: { shimmed: 'bin/tool.mjs' },
    slicc: { abi: 'js', commands: { shimmed: { module: 'bin/tool.mjs' } } },
  };
  await writeFile(join(dir, 'package', 'package.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'package', 'bin', 'tool.mjs'), TOOL);
  execFileSync('tar', ['czf', join(dir, 't.tgz'), '-C', dir, 'package']);
  const bytes = await readFile(join(dir, 't.tgz'));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}
