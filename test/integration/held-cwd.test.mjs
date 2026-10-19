import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 300_000 };

async function install(kernel, name, skip) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    const rel = relative(fileURLToPath(base), file);
    if (skip?.test(rel)) continue;
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${rel}`, await readFile(file));
  }
}

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  const sh = (script, env = '') =>
    kernel.run(['bash', '-c', `export PATH=/usr/bin:/bin; ${env}${script}`], { cwd: '/' });
  return { sh, kernel };
}

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(['import os, sys', ...lines].join('\n')).toString('base64')} | base64 -d)"`;

const fixture = new URL('fixtures/heldcwd/', import.meta.url);

const REPLACEMENTS = [
  ['rm -r d; mv n d', 'mkdir /t/n && touch /t/n/x && rm -r /t/d && mv /t/n /t/d'],
  ['rm -r d; mkdir d', 'rm -r /t/d && mkdir /t/d && touch /t/d/x'],
  ['mv d away; mv n d', 'mkdir /t/n && touch /t/n/x && mv /t/d /t/away && mv /t/n /t/d'],
];

const held = (replace) =>
  [
    'rm -rf /t; mkdir -p /t/d /t/s && touch /t/d/old',
    'cd /t/d',
    '{ until [ -e /t/s/go ]; do sleep 0.05; done; echo go; } | heldcwd > /t/s/out &',
    'p=$!',
    'cd /',
    'n=0; until [ -s /t/s/out ] || [ $n -ge 2400 ]; do sleep 0.05; n=$((n+1)); done',
    replace,
    'touch /t/s/go',
    'wait $p',
    'cat /t/s/out',
  ].join('\n');

for (const [name, replace] of REPLACEMENTS) {
  test(
    `a wasip1 program whose cwd is replaced by "${name}" keeps the removed directory: . lists nothing, a relative create and stat are NotFound, and .. still lists the parent (#1164)`,
    TIMEOUT,
    async (t) => {
      const { sh, kernel } = await booted(t);
      for (const file of ['package.json', 'bin/heldcwd.wasm']) {
        await kernel.writeFile(
          `/node_modules/heldcwd/${file}`,
          await readFile(new URL(file, fixture))
        );
      }
      const r = await sh(held(replace));
      const parent = name.startsWith('mv d away') ? '[away,d,n,s]' : '[d,s]';
      assert.equal(
        r.stdout,
        `before [old]\nafter error entity not found\ncreate NotFound\nstat NotFound\nparent ${parent.replace(',n,', ',')}\n`,
        r.stderr
      );
    }
  );
}

test(
  'a wasip1 program making relative lookups in a held cwd with no directory changes asks the kernel nothing about the cwd, and once after one (#1164)',
  TIMEOUT,
  async (t) => {
    const { sh, kernel } = await booted(t);
    for (const file of ['package.json', 'bin/heldcwd.wasm']) {
      await kernel.writeFile(
        `/node_modules/heldcwd/${file}`,
        await readFile(new URL(file, fixture))
      );
    }
    await sh('mkdir -p /t/d && touch /t/d/old');
    const checks = (stderr) =>
      stderr
        .split('\n')
        .filter((l) => /\skernel\.cwd-check$/.test(l))
        .reduce((n, l) => n + Number(l.trim().split(/\s+/)[1]), 0);
    const quiet = await sh(
      'cd /t/d && heldcwd loop 500 < /dev/null',
      'export SLICC_WASI_STATS=1; '
    );
    assert.equal(quiet.stdout, 'looped 500\n', quiet.stderr);
    assert.match(
      quiet.stderr,
      /\s1000\s+\S+\s+wasi\.path_filestat_get$/m,
      'the stats were printed'
    );
    assert.equal(checks(quiet.stderr), 0);
    const moved = await sh(
      'cd /t/d && { until [ -e /tmp/go ]; do sleep 0.05; done; echo; } | heldcwd loop 500 & p=$!; cd /; sleep 0.5; touch /t/d; touch /tmp/go; wait $p',
      'export SLICC_WASI_STATS=1; '
    );
    assert.equal(moved.stdout, 'looped 500\n', moved.stderr);
    assert.equal(checks(moved.stderr), 1);
  }
);
