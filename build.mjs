import { readFile, rm } from 'node:fs/promises';
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
