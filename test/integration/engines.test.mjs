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

async function fixture(kernel, name, engines) {
  await kernel.writeFile(
    `/node_modules/${name}/package.json`,
    JSON.stringify({
      name,
      version: '1.0.0',
      ...(engines === undefined ? {} : { engines }),
      slicc: { commands: { [name]: { script: 'bin/run' } } },
    })
  );
  await kernel.writeFile(`/node_modules/${name}/bin/run`, `#!/bin/bash\necho ${name} ran "$@"\n`);
}

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const shown = await kernel.run(['cat', '/proc/version'], { cwd: '/' });
  const version = /slicc-kernel (\S+)\)/.exec(shown.stdout)?.[1];
  const major = Number(/^(\d+)\./.exec(version ?? '')?.[1]);
  assert.ok(major >= 1, `this build has no release version: ${version}`);
  return { kernel, version, major };
}

test('a package whose engines.slicc-kernel floor is above this kernel has its commands refused with 126 (#797)', async (t) => {
  const { kernel, version, major } = await booted(t);
  const floor = `>=${major + 1}.0.0`;
  await fixture(kernel, 'floored', { 'slicc-kernel': floor });
  await fixture(kernel, 'fits', { 'slicc-kernel': `>=1.0.0 <${major + 1} || ^${major + 5}` });
  await fixture(kernel, 'plain');
  const message = `floored: floored@1.0.0 needs slicc-kernel ${floor}; this kernel is ${version}\n`;
  assert.deepEqual(await kernel.run(['floored', 'x'], { cwd: '/' }), {
    status: 126,
    stdout: '',
    stderr: message,
  });
  assert.deepEqual(
    await kernel.run(['bash', '-c', 'floored; echo rc=$?; ls /usr/bin/floored; fits; plain'], {
      cwd: '/',
    }),
    { status: 0, stdout: 'rc=126\n/usr/bin/floored\nfits ran\nplain ran\n', stderr: message }
  );
  await kernel.writeFile('/tmp/by-floored', '#!/usr/bin/floored\necho never\n');
  assert.deepEqual(
    await kernel.run(['bash', '-c', 'chmod +x /tmp/by-floored && /tmp/by-floored; echo rc=$?'], {
      cwd: '/',
    }),
    { status: 0, stdout: 'rc=126\n', stderr: message }
  );
  const term = await kernel.openTerminal(['floored'], { cwd: '/', onData() {} });
  assert.equal(await term.exited, 126);
});

test('an unreadable engines.slicc-kernel range refuses only that package, and a non-string one is no constraint (#797)', async (t) => {
  const { kernel } = await booted(t);
  await fixture(kernel, 'banana', { 'slicc-kernel': '>=banana' });
  await fixture(kernel, 'numbered', { 'slicc-kernel': 5 });
  await fixture(kernel, 'listed', ['slicc-kernel']);
  await fixture(kernel, 'plain');
  assert.deepEqual(
    await kernel.run(['bash', '-c', 'banana; echo rc=$?; numbered; listed; plain'], { cwd: '/' }),
    {
      status: 0,
      stdout: 'rc=126\nnumbered ran\nlisted ran\nplain ran\n',
      stderr: `banana: banana@1.0.0 has an engines.slicc-kernel range this kernel can't read: ">=banana"\n`,
    }
  );
});
