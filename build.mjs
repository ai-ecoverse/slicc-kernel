import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: [
    'src/index.ts',
    'src/kernel-worker.ts',
    'src/process-worker.ts',
    'src/driver-worker.ts',
    'src/driver.ts',
  ],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  sourcemap: 'linked',
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
  logLevel: 'warning',
});
