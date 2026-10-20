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
  assert.deepEqual(await kernel.run(['cat', '/usr/bin/floored'], { cwd: '/' }), {
    status: 0,
    stdout: '#!/bin/bash\necho floored ran "$@"\n',
    stderr: '',
  });
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

test('a package below its engines.slicc-kernel floor is refused when its glue is run by path, with or without the .wasm beside it, and when a byte-identical copy of the glue named for its command is, as by name: 126 and the same message (#1235, homescoop#1285)', async (t) => {
  const { kernel, version, major } = await booted(t);
  const floor = `>=${major + 1}.0.0`;
  const glue = await readFile(new URL('wasm-coreutils/bin/coreutils', modules));
  const wasm = await readFile(new URL('wasm-coreutils/bin/coreutils.wasm', modules));
  await kernel.writeFile(
    '/node_modules/emfloored/package.json',
    JSON.stringify({
      name: 'emfloored',
      version: '1.0.0',
      engines: { 'slicc-kernel': floor },
      slicc: {
        commands: {
          emfloored: { glue: 'bin/emfloored', wasm: 'bin/emfloored.wasm', args: ['echo'] },
          emcopy: { glue: 'bin/emfloored', wasm: 'bin/emfloored.wasm', args: ['echo'] },
        },
      },
    })
  );
  await kernel.writeFile('/node_modules/emfloored/bin/emfloored', glue);
  await kernel.writeFile('/node_modules/emfloored/bin/emfloored.wasm', wasm);
  await kernel.writeFile('/node_modules/emfloored/bin/emcopy', glue);
  const message = (name) =>
    `${name}: emfloored@1.0.0 needs slicc-kernel ${floor}; this kernel is ${version}\n`;
  const r = await kernel.run(
    [
      'bash',
      '-c',
      [
        'emfloored hi; echo "name rc=$?"',
        '/node_modules/emfloored/bin/emfloored hi; echo "glue rc=$?"',
        '/node_modules/emfloored/bin/emfloored.wasm hi; echo "wasm rc=$?"',
        '/node_modules/emfloored/bin/emcopy hi; echo "copy rc=$?"',
      ].join('; '),
    ],
    { cwd: '/' }
  );
  assert.equal(r.stdout, 'name rc=126\nglue rc=126\nwasm rc=126\ncopy rc=126\n', r.stderr);
  assert.equal(
    r.stderr,
    [message('emfloored'), message('emfloored'), message('emfloored'), message('emcopy')].join('')
  );
});

test('a refused package is refused by path when its command names are all taken, by a built-in or an earlier package, and for a variant wasm; a shared wasm names its own command; a directory at a declared path and a copy of a refused script are not refused (#1248)', async (t) => {
  const { kernel, version, major } = await booted(t);
  const floor = { 'slicc-kernel': `>=${major + 1}.0.0` };
  const glue = await readFile(new URL('wasm-coreutils/bin/coreutils', modules));
  const wasm = await readFile(new URL('wasm-coreutils/bin/coreutils.wasm', modules));
  const wasi = await readFile(new URL('./fixtures/heldcwd/bin/heldcwd.wasm', import.meta.url));
  const write = (path, data) => kernel.writeFile(`/node_modules/${path}`, data);
  const manifest = (name, slicc, engines = floor) =>
    write(`${name}/package.json`, JSON.stringify({ name, version: '1.0.0', engines, slicc }));
  await manifest('zsudo', {
    commands: { sudo: { glue: 'bin/zsudo', wasm: 'bin/zsudo.wasm', args: ['echo'] } },
  });
  await write('zsudo/bin/zsudo', glue);
  await write('zsudo/bin/zsudo.wasm', wasm);
  await manifest('aaplain', { commands: { dup: { script: 'bin/dup' } } }, {});
  await write('aaplain/bin/dup', '#!/bin/bash\necho plain dup\n');
  await manifest('zzdup', {
    commands: { dup: { glue: 'bin/zzdup', wasm: 'bin/zzdup.wasm', args: ['echo'] } },
  });
  await write('zzdup/bin/zzdup', glue);
  await write('zzdup/bin/zzdup.wasm', wasm);
  await manifest('wvar', {
    abi: 'wasi',
    commands: {
      wvar: {
        wasm: 'bin/wvar.wasm',
        variants: [{ env: { WVAR: '1' }, wasm: 'bin/wvar-alt.wasm' }],
      },
    },
  });
  await write('wvar/bin/wvar.wasm', wasi);
  await write('wvar/bin/wvar-alt.wasm', wasi);
  await manifest('wshared', {
    abi: 'wasi',
    commands: { alias: { wasm: 'bin/foo.wasm' }, foo: { wasm: 'bin/foo.wasm' } },
  });
  await write('wshared/bin/foo.wasm', wasi);
  await manifest('dirglue', {
    commands: { dirglue: { glue: 'bin/dirglue', wasm: 'bin/dirglue.wasm' } },
  });
  await kernel.run(['mkdir', '-p', '/node_modules/dirglue/bin/dirglue'], { cwd: '/' });
  await write('dirglue/bin/dirglue.wasm', wasm);
  await manifest('scr', { commands: { scr: { script: 'bin/run' } } });
  await write('scr/bin/run', '#!/bin/bash\necho scr ran\n');
  await write('scr/bin/scr', '#!/bin/bash\necho scr ran\n');
  const needs = (name, pkg) =>
    `${name}: ${pkg}@1.0.0 needs slicc-kernel ${floor['slicc-kernel']}; this kernel is ${version}\n`;
  const run = (script) =>
    kernel.run(['bash', '-c', `chmod +x ${script.split(' ')[0]}; ${script}; echo "rc=$?"`], {
      cwd: '/',
    });
  assert.deepEqual(await run('/node_modules/zsudo/bin/zsudo hi'), {
    status: 0,
    stdout: 'rc=126\n',
    stderr: needs('sudo', 'zsudo'),
  });
  assert.deepEqual(await run('/node_modules/zzdup/bin/zzdup hi'), {
    status: 0,
    stdout: 'rc=126\n',
    stderr: needs('dup', 'zzdup'),
  });
  const dup = await kernel.run(['dup'], { cwd: '/' });
  assert.equal(dup.stdout, 'plain dup\n', JSON.stringify(dup));
  assert.deepEqual(await run('/node_modules/wvar/bin/wvar-alt.wasm'), {
    status: 0,
    stdout: 'rc=126\n',
    stderr: needs('wvar', 'wvar'),
  });
  assert.deepEqual(await run('/node_modules/wshared/bin/foo.wasm'), {
    status: 0,
    stdout: 'rc=126\n',
    stderr: needs('foo', 'wshared'),
  });
  const dir = await run('/node_modules/dirglue/bin/dirglue');
  assert.doesNotMatch(dir.stderr, /needs slicc-kernel/);
  assert.match(dir.stderr, /directory/i);
  assert.deepEqual(await run('/node_modules/scr/bin/scr'), {
    status: 0,
    stdout: 'scr ran\nrc=0\n',
    stderr: '',
  });
});
