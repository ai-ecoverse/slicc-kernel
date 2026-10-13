import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

async function booted(t, users) {
  const kernel = await createNodeKernel({ users });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  return kernel;
}

const GRANDCHILD = 'sleep 30 & cat /proc/$!/status; kill $!';

function tagLines(text) {
  return text.split('\n').filter((line) => line.startsWith('Tag:'));
}

async function terminalOutput(kernel, argv, options) {
  const screen = [];
  const term = await kernel.openTerminal(argv, options);
  term.onData = (bytes) => screen.push(new TextDecoder().decode(bytes));
  await term.exited;
  return screen.join('').replaceAll('\r', '');
}

for (const users of ['off', 'report', 'enforce']) {
  test(`/proc/<pid>/status shows the inherited tag to its own user (users: ${users})`, async (t) => {
    const kernel = await booted(t, users);
    const tag = '{"kind":"user","panel":1}';
    const shown = await terminalOutput(kernel, ['bash', '-c', GRANDCHILD], { tag });
    assert.deepEqual(tagLines(shown), [`Tag:\t${tag}`]);
    assert.match(shown, /Uid:[^\n]*\nGid:[^\n]*\nTag:/);

    const untagged = await kernel.run(['bash', '-c', GRANDCHILD]);
    assert.equal(untagged.status, 0, untagged.stderr);
    assert.deepEqual(tagLines(untagged.stdout), []);
    assert.match(untagged.stdout, /^Uid:/m);

    const split = await kernel.run(['bash', '-c', 'cat /proc/$$/status'], { tag: 'a\nb\tc' });
    assert.deepEqual(tagLines(split.stdout), ['Tag:\ta\\nb\\tc']);

    const client = await attachKernel(await kernel.connect({ tag: 'agent' }));
    t.after(() => client.close());
    const ran = await client.run(['bash', '-c', GRANDCHILD]);
    assert.deepEqual(tagLines(ran.stdout), ['Tag:\tagent']);
    const child = await client.spawn(['sleep', '30']);
    const rows = await client.ps();
    assert.equal(rows.find((row) => row.pid === child.pid)?.tag, 'agent');
    const plain = await kernel.run(['sleep', '0']).then(() => client.ps());
    assert.ok(plain.filter((row) => row.pid !== child.pid).every((row) => row.tag === undefined));
    await child.signal('SIGTERM');
    await child.exited;
  });
}

test('a cone sees no tag of a root process, and root sees it (users: enforce)', async (t) => {
  const kernel = await booted(t, 'enforce');
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  const root = await attachKernel(await kernel.connect({ tag: 'bios' }));
  t.after(() => root.close());
  const job = await root.spawn(['sleep', '30']);
  const status = `cat /proc/${job.pid}/status; echo "rc=$?"`;

  const byRoot = await kernel.run(['bash', '-c', status]);
  assert.deepEqual(tagLines(byRoot.stdout), ['Tag:\tbios']);
  const byCone = await kernel.run(['bash', '-c', status], { user: 'cone', cwd: '/home/cone' });
  assert.deepEqual(tagLines(byCone.stdout), []);
  assert.doesNotMatch(byCone.stdout, /bios/);

  const cone = await attachKernel(await kernel.connect({ user: 'cone', tag: 'agent' }));
  t.after(() => cone.close());
  const own = await cone.spawn(['sleep', '30']);
  const seen = await cone.ps();
  assert.equal(seen.find((row) => row.pid === own.pid)?.tag, 'agent');
  assert.equal(
    seen.find((row) => row.pid === job.pid),
    undefined
  );
  assert.equal((await root.ps()).find((row) => row.pid === job.pid)?.tag, 'bios');
  await own.signal('SIGTERM');
  await job.signal('SIGTERM');
  await Promise.all([own.exited, job.exited]);
});
