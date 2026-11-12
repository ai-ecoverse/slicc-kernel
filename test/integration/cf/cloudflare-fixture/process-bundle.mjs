import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { REPO } from './dev.mjs';

export async function bundledProcess() {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../async-link-process.mjs', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    logLevel: 'warning',
    plugins: [
      {
        name: 'transport-from-src',
        setup(on) {
          on.onResolve({ filter: /dist\/node\.js$/ }, () => ({
            path: `${REPO}src/async/transport.ts`,
          }));
          on.onResolve({ filter: /^node:worker_threads$/ }, () => ({
            path: 'worker_threads',
            namespace: 'shim',
          }));
          on.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
            contents: 'export const isMainThread = true;',
          }));
        },
      },
    ],
  });
  return out.outputFiles[0].text;
}
