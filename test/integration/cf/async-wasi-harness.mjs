import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../../dist/node.js';

export const jspi =
  typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';

export const skip = jspi ? false : 'this Node has no WebAssembly.Suspending (JSPI)';

const modules = new URL('../../../node_modules/@ai-ecoverse/', import.meta.url);
const fixtures = new URL('../fixtures/', import.meta.url);

async function copyTree(kernel, base, to, only) {
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    const rel = relative(base, file);
    if (only && !only(rel)) continue;
    await kernel.writeFile(`${to}/${rel}`, await readFile(file));
  }
}

export function installPackage(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  return copyTree(kernel, base, `/node_modules/@ai-ecoverse/${name}`);
}

export function installFixture(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, fixtures));
  const wanted = (rel) =>
    rel === 'package.json' || rel.startsWith('bin/') || rel.startsWith('lib/');
  return copyTree(kernel, base, `/node_modules/${name}`, wanted);
}

export async function kernelPair(t, setup, options = {}) {
  const sync = await createNodeKernel(options);
  const async = await createNodeKernel({ ...options, blocking: 'async' });
  t.after(() => {
    sync.terminate();
    async.terminate();
  });
  await Promise.all([setup(sync), setup(async)]);
  return { sync, async };
}

export async function both(pair, argv, options = {}) {
  const sync = await pair.sync.run(argv, options);
  const async = await pair.async.run(argv, options);
  return { sync, async };
}

export function shown(result) {
  return {
    status: result.status,
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
