import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  if (write) assertAsyncBundle(await readFile(join(root, outfile), 'utf8'));
  return { derived, result };
}

const REFUSED = [
  [/\bnew Function\b/, 'new Function'],
  [/\beval\s*\(/, 'eval'],
  [/WebAssembly\.compile\b/, 'WebAssembly.compile'],
  [/new WebAssembly\.Module\s*\(/, 'new WebAssembly.Module'],
  [/^\s*import\s/m, 'an import statement'],
  [/\bimport\s*\(/, 'a dynamic import'],
  [/\brequire\s*\(/, 'require'],
];

export function assertAsyncBundle(text) {
  for (const [pattern, what] of REFUSED) {
    if (pattern.test(text)) throw new Error(`dist/async-process.js must not contain ${what}`);
  }
  if (!/export\s*\{[^}]*\basyncProcessEntry\b/.test(text)) {
    throw new Error('dist/async-process.js must export asyncProcessEntry');
  }
}
