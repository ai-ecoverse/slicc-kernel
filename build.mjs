import { execFileSync } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { version } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const define = { SLICC_VERSION: JSON.stringify(version) };
await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: [
    'src/index.ts',
    'src/kernel-worker.ts',
    'src/process-worker.ts',
    'src/driver-worker.ts',
    'src/driver.ts',
    'src/testing.ts',
    'src/meta.ts',
  ],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  sourcemap: 'linked',
  define,
  logLevel: 'warning',
});
await build({
  entryPoints: ['src/node.ts', 'src/node-process-worker.ts', 'src/node-driver-worker.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'linked',
  define,
  logLevel: 'warning',
});
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('./node_modules/typescript/bin/tsc', import.meta.url)),
    '-p',
    'tsconfig.types.json',
  ],
  {
    stdio: 'inherit',
  }
);
const types = fileURLToPath(new URL('./dist/types/', import.meta.url));
for (const entry of await readdir(types, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
  const file = join(entry.parentPath, entry.name);
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(/((?:from|import\()\s*')(\.{1,2}\/[^']*)\.ts'/g, "$1$2.js'"));
}
