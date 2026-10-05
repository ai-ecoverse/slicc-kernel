import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts', 'src/kernel-worker.ts', 'src/process-worker.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  sourcemap: 'linked',
  logLevel: 'warning',
});
