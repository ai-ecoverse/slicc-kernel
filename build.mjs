import { execFileSync } from 'node:child_process';
import { appendFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { version: declared } = JSON.parse(
  await readFile(new URL('./package.json', import.meta.url), 'utf8')
);
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const quiet = (run) => {
  try {
    return run();
  } catch {
    return '';
  }
};
const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;
const newest = (tags) =>
  tags
    .map((tag) => RELEASE.exec(tag))
    .filter(Boolean)
    .sort((a, b) => b[1] - a[1] || b[2] - a[2] || b[3] - a[3])[0]?.[0];
const releaseTag = () =>
  newest(quiet(() => git('tag', '--list', 'v*')).split('\n')) ??
  newest(
    quiet(() => git('ls-remote', '--tags', '--refs', 'origin', 'v*'))
      .split('\n')
      .map((line) => line.split('refs/tags/')[1] ?? '')
  );
const dev = declared === '0.0.0' || declared.startsWith('0.0.0-');
const tag = dev ? releaseTag() : undefined;
const version = tag ? `${tag.slice(1)}+dev` : declared;
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
await appendFile(
  new URL('./dist/node-process-worker.js', import.meta.url),
  '//# sourceURL=slicc-kernel:/node-process-worker.js\n'
);
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
