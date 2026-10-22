import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const modules = join(root, 'node_modules/@ai-ecoverse');

async function install(kernel, name) {
  const base = join(modules, name);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

test('the packed tarball, installed on its own, runs homescoop bash and coreutils from its Node entry: a pipeline, a fork and the command catalog', {
  timeout: 120_000,
}, async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'kernel-packed-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packed = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--silent', '--pack-destination', dir],
    { cwd: root, encoding: 'utf8' }
  ).trim();
  const consumer = join(dir, 'consumer');
  const installed = join(consumer, 'node_modules/@ai-ecoverse/slicc-kernel');
  await mkdir(installed, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    join(dir, packed.split('\n').at(-1)),
    '-C',
    installed,
    '--strip-components=1',
  ]);
  await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
  const entry = createRequire(join(consumer, 'index.js')).resolve('@ai-ecoverse/slicc-kernel/node');
  assert.ok(entry.startsWith(installed), entry);
  const { createNodeKernel } = await import(pathToFileURL(entry).href);
  const kernel = await createNodeKernel({});
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const run = await kernel.run(
    ['bash', '-c', 'echo packed | tr a-z A-Z; (sleep 0; echo child) | cat; command -v ls wc'],
    { cwd: '/' }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'PACKED\nchild\n/usr/bin/ls\n/usr/bin/wc\n');
});
