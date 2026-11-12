import { build } from 'esbuild';
import { config } from './config.mjs';
import { deriveAsync, derivedPlugin } from './index.mjs';

export async function buildAsyncProcess({ root, outfile, define = {}, write = true }) {
  const derived = await deriveAsync({ root, config });
  const result = await build({
    absWorkingDir: root,
    entryPoints: config.entries,
    outfile,
    bundle: true,
    splitting: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: 'es2024',
    sourcemap: write ? 'linked' : false,
    define,
    write,
    logLevel: 'warning',
    plugins: [derivedPlugin(derived)],
  });
  return { derived, result };
}
