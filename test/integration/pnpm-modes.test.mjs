import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

async function tarball() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-modes-'));
  await mkdir(join(dir, 'package', 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package', 'package.json'),
    JSON.stringify({ name: 'modes', version: '1.0.0' })
  );
  await writeFile(join(dir, 'package', 'bin', 'run.sh'), '#!/bin/sh\necho ran\n');
  await chmod(join(dir, 'package', 'bin', 'run.sh'), 0o755);
  await writeFile(join(dir, 'package', 'lib.js'), 'export {};\n');
  execFileSync('tar', ['czf', join(dir, 'm.tgz'), '-C', dir, 'package']);
  const bytes = await readFile(join(dir, 'm.tgz'));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

const PROBE = 'stat -c "%a %U" node_modules/modes/bin/run.sh node_modules/modes/lib.js';

for (const users of ['enforce', 'off']) {
  test(`pnpm's store and node_modules files keep their modes, an executable 755 and a plain file 644 (users: ${users})`, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm']) {
      await install(kernel, name);
    }
    await kernel.writeFile('/srv/m.tgz', await tarball());
    const run = (mask, dir) =>
      kernel.run(
        [
          'bash',
          '-c',
          `umask ${mask}; mkdir -p ${dir} && cd ${dir} && echo '{}' > package.json && pnpm add file:/srv/m.tgz >/dev/null 2>&1; echo "rc=$?"; ${PROBE}`,
        ],
        { cwd: '/' }
      );
    assert.deepEqual(await run('022', '/home/a'), {
      status: 0,
      stdout: 'rc=0\n755 root\n644 root\n',
      stderr: '',
    });
  });
}
